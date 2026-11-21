import { beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../../stores/browserStore';
import { serializeState } from '../../../stores/historySlice';
import { SESSION_PRE_VIEWPORT_KEYS } from '../../../api/session';
import { DEFAULT_CLUSTER_VIEW_SETTINGS } from '../../../utils/clusterViewSettings';
import { REG_PERIOD_CHANNEL, REG_SCORE_CHANNEL } from '../../../utils/clusterViewChannels';
import { toggleProfileChannel } from './ClusterViewControls';
import { datasetsToAnalyse, needsAnalyse, regularityProfiles } from './useClusterRegularity';
import type { RegSeries } from '../../../features/nucleosomes/RegularityView';
import type { NucRegularityResult } from '../../../features/nucleosomes/types';

describe('cluster view settings in the store', () => {
  beforeEach(() => useBrowserStore.setState({ clusterViewSettings: DEFAULT_CLUSTER_VIEW_SETTINGS }));

  it('default to today\'s view and change without touching the clustering', () => {
    const before = useBrowserStore.getState();
    expect(before.clusterViewSettings).toEqual(DEFAULT_CLUSTER_VIEW_SETTINGS);
    const assignments = before.clusterAssignments;
    before.setClusterViewSettings({ profileChannels: ['tf'], mapColorBy: 'reg.median' });
    const after = useBrowserStore.getState();
    expect(after.clusterViewSettings).toMatchObject({ profileChannels: ['tf'], mapColorBy: 'reg.median', mapFeatureMode: null });
    expect(after.clusterAssignments).toBe(assignments);
  });

  it('are saved with the session and undo snapshots', () => {
    useBrowserStore.getState().setClusterViewSettings({ mapFeatureMode: 'nuc' });
    expect(SESSION_PRE_VIEWPORT_KEYS).toContain('clusterViewSettings');
    expect(serializeState(useBrowserStore.getState()).clusterViewSettings).toMatchObject({ mapFeatureMode: 'nuc' });
  });
});

describe('channel picker', () => {
  it('starts a selection from the default and returns to it when the last channel goes', () => {
    expect(toggleProfileChannel(null, 'tf')).toEqual(['tf']);
    expect(toggleProfileChannel(['tf'], 'nuc')).toEqual(['tf', 'nuc']);
    expect(toggleProfileChannel(['tf', 'nuc'], 'tf')).toEqual(['nuc']);
    expect(toggleProfileChannel(['nuc'], 'nuc')).toBeNull();
  });
});

describe('regularity per cluster', () => {
  const series = [
    { obsId: 'p1::c0', stateKey: 'p1', cluster: 0, start: 1000, end: 2000 },
    { obsId: 'p1::c1', stateKey: 'p1', cluster: 1, start: 1000, end: 2000 },
  ] as unknown as RegSeries[];
  const result = {
    observations: [
      { obsId: 'p1::c0', datasetId: 'd', molecules: 5, scored: 5, track: { edges: [1000, 1500, 2000], mean: [3, 5], n: [4, 4], period: [180, 190] } },
      { obsId: 'p1::c1', datasetId: 'd', molecules: 5, scored: 0, notComputed: 0, track: { edges: [1000, 1500, 2000], mean: [null, null], n: [0, 0] } },
    ],
    datasets: {},
    updatedDatasets: [],
  } as unknown as NucRegularityResult;

  it('resamples each cluster\'s score and period track onto the profile bins', () => {
    const out = regularityProfiles(series, result, 10);
    expect(out.p1[0][REG_SCORE_CHANNEL]).toEqual([3, 3, 3, 3, 3, 5, 5, 5, 5, 5]);
    expect(out.p1[0][REG_PERIOD_CHANNEL][9]).toBe(190);
    expect(out.p1[1]).toBeUndefined();
  });

  it('asks for Analyse only when nothing could be scored for want of nucleosome calls', () => {
    expect(needsAnalyse([{ obsId: 'a', datasetId: 'd', scored: 0, notComputed: 12 }])).toBe(true);
    expect(needsAnalyse([{ obsId: 'a', datasetId: 'd', scored: 3, notComputed: 12 }])).toBe(false);
    expect(needsAnalyse([{ obsId: 'a', datasetId: 'd', scored: 0, notComputed: 0 }])).toBe(false);
    // Each dataset on its own: one scored dataset doesn't hide another without calls.
    expect(datasetsToAnalyse([
      { obsId: 'a0', datasetId: 'A', scored: 30, notComputed: 0 }, { obsId: 'b0', datasetId: 'B', scored: 0, notComputed: 40 },
      { obsId: 'b1', datasetId: 'B', scored: 0, notComputed: 9 },
    ])).toEqual(['B']);
  });
});
