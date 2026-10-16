import { beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../browserStore';
import type { PanelConfig } from '../../types';

const base = { contentType: 'dataset' as const, subTracks: [], linkGroup: null, layoutRow: 0 };
const source: PanelConfig = { ...base, id: 'src', datasetId: 'numb', collapsed: true, collapsedBySplitGroup: 'split-1' };
const member = (id: string, datasetId = 'numb'): PanelConfig => ({
  ...base, id, datasetId, collapsed: false, stateKey: `numb:split-1:${id}`,
  readSubset: { groupId: 'split-1', label: id, colour: '#000', count: 1, sourcePanelId: 'src', rule: { kind: 'frozen', datasetId: 'numb', groupKeys: ['0'] } },
});

describe('a split closed panel by panel shows its source again', () => {
  beforeEach(() => {
    useBrowserStore.setState({ panels: [source, member('carriers', 'alt-1'), member('ref'), member('na')], datasets: [], fullViewPanelId: null });
  });

  it('only when its last panel goes', () => {
    useBrowserStore.getState().removePanel('ref');
    expect(useBrowserStore.getState().panels.find(p => p.id === 'src')!.collapsed).toBe(true);
    useBrowserStore.getState().removePanel('na');
    expect(useBrowserStore.getState().panels.find(p => p.id === 'src')!.collapsed).toBe(true);
    // The insert-expanded Carriers panel goes with its alt dataset.
    useBrowserStore.getState().removeDataset('alt-1');
    const src = useBrowserStore.getState().panels.find(p => p.id === 'src')!;
    expect(src.collapsed).toBe(false);
    expect(src.collapsedBySplitGroup).toBeUndefined();
  });

  it('a source shown again by hand is no longer held by the split', () => {
    useBrowserStore.getState().setPanelCollapsed('src', false);
    expect(useBrowserStore.getState().panels.find(p => p.id === 'src')!.collapsedBySplitGroup).toBeUndefined();
  });
});
