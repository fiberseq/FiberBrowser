import '../testSetup';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { FireTrack } from '../../components/tracks/FireTrack';
import { useBrowserStore } from '../../stores/browserStore';
import { useEphemeralStore } from '../../stores/ephemeralStore';
import { DEFAULT_PEAK_RULES } from '../../types';
import { rigidMatchedRegions } from '../../utils/matchedRegions';
import { linkSelectedRegions } from './matchedRegions';
import { trackMenuItems } from '../../components/tracks/trackRegistry';

const canvas = vi.hoisted(() => new Proxy({ measureText: () => ({ width: 20 }) }, { get: (target: any, key) => target[key] ??= vi.fn() }));
vi.mock('../../utils/canvasUtils', async importOriginal => ({ ...await importOriginal<object>(), setupHighDpiCanvas: () => canvas }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let node: HTMLDivElement, root: Root;
beforeEach(() => {
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  useBrowserStore.setState({ peakRules: DEFAULT_PEAK_RULES, peaksByRule: {}, selectedPeaks: new Set(), peakModes: {},
    chrom: 'chr1', start: 0, end: 1000, activeReadIds: {}, maxRegionForReads: 10000, datasets: [], peakDrawMode: false });
  const regions = rigidMatchedRegions([{ index: 0, chrom: 'chr1', start: 100, end: 200 }, { index: 1, chrom: 'chr2', start: 500, end: 600 }], 'chr1');
  regions[0].end = 250;
  regions[0].match!.blocks = [{ frame: [0, 50], genomic: [100, 150] }, { frame: [50, 100], genomic: [200, 250] }];
  useBrowserStore.getState().upsertMatchedGroup({ id: 'matched-f', name: 'F1', regions });
});
afterEach(() => { act(() => root.unmount()); node.remove(); });

it('draws block segments without reads and selects partners across chromosome panels', () => {
  act(() => root.render(<><FireTrack width={1000} height={70} readsKey="empty" /><FireTrack width={1000} height={70} readsKey="empty" overrideChrom="chr2" /></>));
  expect(node.querySelectorAll('button[data-testid^="matched-region-"]')).toHaveLength(2);
  expect((canvas as any).fillRect).toHaveBeenCalledWith(100, expect.any(Number), 50, expect.any(Number));
  expect((canvas as any).fillRect).toHaveBeenCalledWith(200, expect.any(Number), 50, expect.any(Number));
  const buttons = node.querySelectorAll<HTMLButtonElement>('button[data-testid^="matched-region-"]');
  act(() => buttons[0].click());
  expect([...useBrowserStore.getState().selectedPeaks]).toEqual([20000, 20001]);
  expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
  act(() => buttons[1].focus());
  expect(useEphemeralStore.getState().hoveredMatchGroup).toBe('matched-f');
  act(() => buttons[1].click());
  expect(useBrowserStore.getState().selectedPeaks.size).toBe(0);
});

it('offers linking in the preview menu and crops new regions while leaving source peaks intact', () => {
  const s = useBrowserStore.getState();
  s.addCustomPeak(100, 200, 'chr1'); s.addCustomPeak(400, 520, 'chr2');
  useBrowserStore.setState({ selectedPeaks: new Set([10000, 10001]) });
  const before = useBrowserStore.getState().peaksByRule['default-custom'];
  const items = trackMenuItems('fire', { panel: {} as never, type: 'fire', datasetId: null, stateKey: null });
  expect(items.find(i => i.id === 'sync-link-matched')?.disabled).toBe(false);
  const id = linkSelectedRegions()!;
  expect(useBrowserStore.getState().peaksByRule['default-custom']).toBe(before);
  expect(useBrowserStore.getState().peaksByRule[id][1]).toMatchObject({ start: 410, end: 510, chrom: 'chr2' });
});
