import '../../../features/testSetup';
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

it('opens a read-derived rule signal in Plots (a metaprofile of its source); track rules have no link', async () => {
  const { useWorkspaceStore } = await import('../../../features/plots/workspace');
  useWorkspaceStore.setState({ view: 'browser' });
  const rule = { ...DEFAULT_PEAK_RULES[0], source: 'accessibility' };
  const node = document.createElement('div'), root = createRoot(node);
  const render = (r: typeof rule) => act(() => root.render(<PeakRuleCard rule={r} signal={[0.1, 0.5, 0.2, 0.4]}
    index={0} isExpanded peakCount={1} viewStart={0} viewEnd={1000} scanning={false} peaksLocked={false} sourceGroups={[]}
    onUpdate={vi.fn()} onRemove={vi.fn()} onToggleEnabled={vi.fn()}
    onToggleExpand={vi.fn()} onRescan={vi.fn()} onDragStart={vi.fn()} onDragOver={vi.fn()} onDragEnd={vi.fn()} />));
  render(rule);
  act(() => node.querySelector<HTMLButtonElement>('[data-testid="peak-rule-open-in-plots"]')!.click());
  expect(useWorkspaceStore.getState().view).toBe('plots');
  expect(useBrowserStore.getState().plotsWorkspace.current).toMatchObject({ type: 'metaprofile', source: 'fire', where: 'view' });
  render({ ...rule, source: 'track:0' });
  expect(node.querySelector('[data-testid="peak-rule-open-in-plots"]')).toBeNull();
  act(() => root.unmount());
});
