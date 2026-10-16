import '../testSetup';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { useUndoToastStore } from '../../stores/undoToastStore';
import { DEFAULT_PEAK_RULES } from '../../types';
import { FireTrack } from '../../components/tracks/FireTrack';
import { PeakDetectionPanel } from '../../components/controls/PeakDetectionPanel';
import { SyncPanel } from './SyncPanel';
import { buildPaletteItems } from '../../utils/commandPaletteItems';
import { trackMenuItems } from '../../components/tracks/trackRegistry';
import { useEphemeralStore } from '../../stores/ephemeralStore';
import { serializeExtensions } from '../../stores/storeExtensions';
import { useSyncPanelState } from './panelState';

const canvas = vi.hoisted(() => new Proxy({ measureText: () => ({ width: 20 }) }, { get: (target: any, key) => target[key] ??= vi.fn() }));
vi.mock('../../utils/canvasUtils', async original => ({ ...await original<object>(), setupHighDpiCanvas: () => canvas }));
vi.mock('../../api/reference', async original => ({ ...await original<object>(), getChromosomes: vi.fn(async () => []), getGenes: vi.fn(async () => ({ genes: [] })) }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let node: HTMLDivElement, root: Root;
const state = () => useBrowserStore.getState();
const button = (id: string) => node.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
beforeEach(() => {
  useSyncPanelState.setState({}, true);
  useBrowserStore.setState({ peakRules: DEFAULT_PEAK_RULES, peaksByRule: {}, selectedPeaks: new Set(), peakModes: {}, comparisonFrames: [], activeComparisonFrameId: null,
    chrom: 'chr1', start: 0, end: 1000, panels: [], datasets: [], activeReadIds: {}, peakDrawMode: false, _historyStack: [], _historyPointer: -1, _lastRestoreTime: 0 });
  for (const id of ['one', 'two']) state().saveComparisonFrame({ id, name: id, version: 1, status: 'accepted', templatePanelId: 'a', alignedOn: ['sequence'], length: 100,
    windows: ['a', 'b'].map((panelId, i) => ({ panelId, datasetId: panelId, label: panelId, genome: i ? 'alt' : null, chrom: 'chr1', start: 100, end: 200,
      strand: '+', blocks: [{ frame: [0, 100], genomic: [100, 200] }], provenance: { metric: 'sequence', score: 1, scores: { sequence: 1 }, flags: [] } })) });
  state().activateComparisonFrame('one');
  state().selectMatchedGroup('matched-one');
  state().pushSnapshot('Saved groups');
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
});
afterEach(() => { act(() => root.unmount()); node.remove(); useUndoToastStore.getState().dismiss(); });

it.each(['row', 'sync', 'card', 'menu', 'palette', 'peaks-all'])('removes through %s with one undo step restoring groups, rows and selection', async path => {
  const all = path === 'palette' || path === 'peaks-all';
  const before = state(), saved = serializeExtensions(before), count = before._historyStack.length;
  await act(async () => root.render(path === 'row' ? <FireTrack width={1000} height={70} readsKey="empty" />
    : path === 'sync' ? <SyncPanel /> : <PeakDetectionPanel />));
  act(() => {
    if (path === 'row') { const remove = button('matched-group-remove-matched-one'); remove.focus(); expect(remove.getAttribute('aria-label')).toBe('Remove F1 · one'); remove.click(); }
    if (path === 'sync') button('sync-group-remove-matched-one').click();
    if (path === 'card') button('matched-group-remove').click();
    if (path === 'peaks-all') button('matched-remove-all').click();
    if (path === 'palette') buildPaletteItems().find(i => i.id === 'cmd:remove-all-matched-regions')!.run();
    if (path === 'menu') {
      useEphemeralStore.setState({ hoveredRegion: { groupId: 'matched-one', label: 'W1' } });
      trackMenuItems('fire', { panel: {} as never, type: 'fire', datasetId: null, stateKey: null }).find(i => i.id === 'sync-remove-group')!.run!();
    }
  });
  expect(state().comparisonFrames.map(f => f.id)).toEqual(all ? [] : ['two']);
  expect(state().peakRules.filter(r => r.source === 'matched')).toHaveLength(all ? 0 : 1);
  expect(state().peaksByRule['matched-one']).toBeUndefined();
  expect(state()._historyStack).toHaveLength(count + 1);
  expect(useUndoToastStore.getState().toast?.text).toBe(all ? 'Removed all matched regions' : 'Removed F1 · one');
  expect(state().activeComparisonFrameId).toBeNull();
  act(() => useUndoToastStore.getState().toast!.undo());
  expect(serializeExtensions(state())).toEqual(saved);
  expect(state().peaksByRule).toEqual(before.peaksByRule);
  expect(state().selectedPeaks).toEqual(before.selectedPeaks);
  act(() => state().redo());
  expect(state().comparisonFrames).toHaveLength(all ? 0 : 1);
});

it('removing a saved frame removes its row and session state', () => {
  state().activateComparisonFrame('two');
  state().removeComparisonFrame('two');
  expect(state().activeComparisonFrameId).toBeNull();
  expect(state().peaksByRule['matched-two']).toBeUndefined();
  expect(serializeExtensions(state()).comparisonFrames).toEqual([expect.objectContaining({ id: 'one' })]);
  useUndoToastStore.getState().toast!.undo();
  expect(state().peaksByRule['matched-two']).toHaveLength(2);
  expect(state().comparisonFrames).toHaveLength(2);
  expect(state().activeComparisonFrameId).toBe('two');
});

it('lists regions and references, shows a group, and renames both records', async () => {
  await act(async () => root.render(<SyncPanel />));
  expect(button('sync-group-matched-one').textContent).toContain('F1 · one');
  expect(button('sync-group-matched-one').textContent).toContain('2 regions · 2 references · Default reference, alt');
  act(() => button('sync-group-show-matched-one').click());
  expect(state().activeComparisonFrameId).toBe('one');
  act(() => button('sync-group-rename-matched-one').click());
  const input = button('sync-group-name');
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Renamed'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  act(() => button('sync-group-save-name').click());
  expect(state().peakRules.find(r => r.id === 'matched-one')?.name).toBe('Renamed');
  expect(state().comparisonFrames[0].name).toBe('Renamed');
  act(() => state().undo());
  expect(state().comparisonFrames[0].name).toBe('one');
  act(() => state().updatePeakRule('matched-one', { name: 'From Peaks' }));
  expect(button('sync-group-matched-one').textContent).toContain('From Peaks');
});
