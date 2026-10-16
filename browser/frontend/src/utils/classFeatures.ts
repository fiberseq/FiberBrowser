/** Footprint classes as features (stores/featureStore.ts): one per Find classes run, dataset and class. */
import { useBrowserStore } from '../stores/browserStore';
import { featureKey, useFeatureStore, type FeatureRef } from '../stores/featureStore';
import { consensusFamilyColor } from './consensusVisual';

export function classFeature(jobId: string, datasetId: string, family: string, start: number, end: number, chrom: string | undefined, label: string): FeatureRef {
  return { kind: 'fp-class', source: jobId, id: family, datasetId, ...(chrom ? { chrom } : {}), start, end, label, colour: consensusFamilyColor(family) };
}

/** Shift / ctrl / cmd-click on a class (a list row, the channel): add it to the feature selection, or take it out. */
export function toggleClassFeatures(refs: FeatureRef[]): void {
  const store = useBrowserStore.getState();
  const keys = new Set(store.selectedFeatures.map(featureKey));
  const allIn = refs.every(r => keys.has(featureKey(r)));
  // Several datasets of one class row go in (or out) together.
  for (const ref of refs) if (keys.has(featureKey(ref)) === allIn) store.selectFeature(ref, true);
}

export function hoverFeature(ref: FeatureRef | null): void {
  useFeatureStore.getState().setHover(ref);
}
