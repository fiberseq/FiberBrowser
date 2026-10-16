/**
 * Usability round 3, R16: closing one of two splits from the same source showed the source panel again while the other
 * split was still open. The source stays folded (held by the other split) until the last split from it closes.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../browserStore';
import { closeSplitPanels } from '../../utils/splitPanels';
import { closeSplitOutcome } from '../../components/tracks/SplitGroupStrip';
import { restoreOrphanSplitSources } from '../splitSources';
import type { PanelConfig } from '../../types';

const base = { contentType: 'dataset' as const, datasetId: 'numb', subTracks: [], linkGroup: null, layoutRow: 0, collapsed: false };
const member = (id: string, groupId: string, key: string): PanelConfig => ({
  ...base, id, stateKey: `numb:${groupId}:${key}`,
  readSubset: { groupId, label: id, colour: '#f00', count: 1, sourcePanelId: 'src', rule: { kind: 'frozen', datasetId: 'numb', groupKeys: [key] } },
}) as PanelConfig;

describe('a source folded by two splits', () => {
  beforeEach(() => {
    useBrowserStore.setState({ panels: [
      // The second split (by two SVs) folded the source last: it holds it.
      { ...base, id: 'src', collapsed: true, collapsedBySplitGroup: 'split-b' },
      member('b1', 'split-b', '0'), member('b2', 'split-b', '1'),
      member('car', 'split-a', '0'), member('ref', 'split-a', '1'),
    ] as PanelConfig[], _historyStack: [], _historyPointer: -1 } as never);
  });
  const src = () => useBrowserStore.getState().panels.find(p => p.id === 'src')!;

  it('closing one split keeps the source folded while the other is open; closing that one shows it', async () => {
    expect(closeSplitOutcome(useBrowserStore.getState().panels, 'split-b')).toMatch(/stays folded/);
    await closeSplitPanels('split-b');
    expect(src().collapsed).toBe(true);
    expect(src().collapsedBySplitGroup).toBe('split-a');
    expect(closeSplitOutcome(useBrowserStore.getState().panels, 'split-a')).toBe('the panel it came from shows again');
    await closeSplitPanels('split-a');
    expect(src().collapsed).toBe(false);
    expect(src().collapsedBySplitGroup).toBeUndefined();
  });

  it('closing the other split\'s panels one by one: the same', () => {
    const panels = restoreOrphanSplitSources(useBrowserStore.getState().panels.filter(p => !p.id.startsWith('b')));
    expect(panels.find(p => p.id === 'src')).toMatchObject({ collapsed: true, collapsedBySplitGroup: 'split-a' });
    const none = restoreOrphanSplitSources(panels.filter(p => p.id === 'src'));
    expect(none[0].collapsed).toBe(false);
  });
});
