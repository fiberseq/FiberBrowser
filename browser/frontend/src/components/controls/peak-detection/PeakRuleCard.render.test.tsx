import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { PeakRuleCard } from './PeakRuleCard';
import { useBrowserStore } from '../../../stores/browserStore';
import { DEFAULT_PEAK_RULES } from '../../../types';
import { rigidMatchedRegions } from '../../../utils/matchedRegions';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it('records card reverse, rename and remove as separate undoable edits', () => {
  useBrowserStore.setState({ peakRules: DEFAULT_PEAK_RULES, peaksByRule: {}, selectedPeaks: new Set(), peakModes: {}, _historyStack: [], _historyPointer: -1 });
  const s = useBrowserStore.getState();
  s.pushSnapshot('Before group');
  s.upsertMatchedGroup({ id: 'g', name: 'Group', regions: rigidMatchedRegions([{ index: 0, start: 10, end: 110, chrom: 'chr1' }], 'chr1') });
  s.pushSnapshot('Create group');
  const node = document.createElement('div'), root = createRoot(node);
  const render = () => act(() => root.render(<PeakRuleCard rule={useBrowserStore.getState().peakRules.find(r => r.id === 'g')!}
    index={2} isExpanded peakCount={1} viewStart={0} viewEnd={1000} scanning={false} peaksLocked={false} sourceGroups={[]}
    onUpdate={updates => s.updatePeakRule('g', updates)} onRemove={() => s.removeMatchedGroup('g')} onToggleEnabled={vi.fn()}
    onToggleExpand={vi.fn()} onRescan={vi.fn()} onDragStart={vi.fn()} onDragOver={vi.fn()} onDragEnd={vi.fn()} />));
  render();
  act(() => node.querySelector<HTMLButtonElement>('[data-testid="matched-region-reverse"]')!.click());
  act(() => s.undo());
  expect(useBrowserStore.getState().peaksByRule.g[0].match?.reversed).toBe(false);
  act(() => s.redo());
  expect(useBrowserStore.getState().peaksByRule.g[0].match?.reversed).toBe(true);
  render();
  const input = node.querySelector<HTMLInputElement>('[data-testid="matched-group-name"]')!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Renamed'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  act(() => s.undo());
  expect(useBrowserStore.getState().peakRules.find(r => r.id === 'g')?.name).toBe('Group');
  act(() => s.redo());
  expect(useBrowserStore.getState().peakRules.find(r => r.id === 'g')?.name).toBe('Renamed');
  render();
  act(() => node.querySelector<HTMLButtonElement>('[data-testid="matched-group-remove"]')!.click());
  act(() => s.undo());
  expect(useBrowserStore.getState().peaksByRule.g[0].match?.reversed).toBe(true);
  act(() => root.unmount());
});
