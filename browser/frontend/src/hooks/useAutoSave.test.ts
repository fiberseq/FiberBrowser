import { describe, expect, it } from 'vitest';
import { AUTO_SAVE_WATCHED_KEYS } from './useAutoSave';

describe('AUTO_SAVE_WATCHED_KEYS', () => {
  it('covers reproducibility-critical analysis and filter state', () => {
    expect([...AUTO_SAVE_WATCHED_KEYS]).toEqual(expect.arrayContaining([
      'analysisSampleSeed',
      'analysisSampleCount',
      'clusterAssignments',
      'clusterOrder',
      'filteredReadIds',
      'clusterFocus',
      'selectedReadIds',
      'selectedGenes',
      'transcriptionStateFilters',
      'activeColormap',
      'footprintGroups',
      'cachedLayerTypes',
      'clickTargetLayer',
      'footprintAnalysisLayer',
      'peaksLocked',
    ]));
  });
});
