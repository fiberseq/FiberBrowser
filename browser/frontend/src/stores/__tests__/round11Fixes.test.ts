import { describe, expect, it } from 'vitest';
import { useBrowserStore } from '../browserStore';
import { transcriptionFilterKeys } from '../../components/controls/TranscriptionStatePanel';

describe('round 11 fixes', () => {
  it('drops dissolved clusters from a panel selection', () => {
    useBrowserStore.setState({ selectedClusters: { p: new Set([1, 2, 3]), q: new Set([2]) } } as never);
    useBrowserStore.getState().pruneClusterSelection('p', new Set([2, 3]));
    useBrowserStore.getState().pruneClusterSelection('q', [2]);
    const sel = useBrowserStore.getState().selectedClusters;
    expect([...(sel.p ?? [])]).toEqual([1]);
    expect(sel.q).toBeUndefined();
  });

  it('a transcription Clear reaches every panel it filtered', () => {
    const keys = transcriptionFilterKeys(['d1'], {
      d1: { target: 'transcription-filters' },
      d2: { target: 'transcription-filters' },
      d3: { target: 'analysis-filter' },
    });
    expect(keys.sort()).toEqual(['d1', 'd2']);
  });
});
