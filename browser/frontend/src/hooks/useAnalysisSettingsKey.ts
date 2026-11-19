import { useMemo } from 'react';
import { useBrowserStore } from '../stores/browserStore';
import { MIN_FOOTPRINTS_ALL_READS } from '../stores/uiSlice';
import type { LayerQualityFilter } from '../types';

/**
 * Settings that change the reads the server analyses: quality filters, legacy
 * layer inference, whether reads without footprint calls are shown (Min
 * footprints' "All reads, including uncalled"), and the refresh generation (bumped when the quality sync
 * lands on the server). An analysis request key that includes this hides its
 * old result at once and fetches again once the server has the new settings.
 */
export function analysisSettingsKey(
  refreshGeneration: number,
  legacyLayerInference: boolean,
  legacyNucMinSize: number,
  qualityFilters: LayerQualityFilter[],
  showUncalled = false,
): string {
  return JSON.stringify([
    refreshGeneration,
    legacyLayerInference,
    legacyNucMinSize,
    qualityFilters.filter(f => f.enabled && f.minValue > 0).map(f => [f.layer, f.qualityName, f.minValue]),
    // Older keys unchanged while uncalled reads are hidden (the default).
    ...(showUncalled ? ['uncalled'] : []),
  ]);
}

export function useAnalysisSettingsKey(): string {
  const refreshGeneration = useBrowserStore(s => s.refreshGeneration);
  const legacyLayerInference = useBrowserStore(s => s.legacyLayerInference);
  const legacyNucMinSize = useBrowserStore(s => s.legacyNucMinSize);
  const qualityFilters = useBrowserStore(s => s.activeColormap.qualityFilters);
  const showUncalled = useBrowserStore(s => s.minFootprints === MIN_FOOTPRINTS_ALL_READS);
  return useMemo(
    () => analysisSettingsKey(refreshGeneration, legacyLayerInference, legacyNucMinSize, qualityFilters, showUncalled),
    [refreshGeneration, legacyLayerInference, legacyNucMinSize, qualityFilters, showUncalled],
  );
}
