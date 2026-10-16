import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { useSplitPanelStore } from '../../stores/splitPanelStore';
import { useCoaccStore } from '../../stores/coaccStore';
import { getCoaccArcs, getCoaccSlice, getCoaccStripUrl } from '../../api/coaccessibility';
import { CoAccTrack } from './CoAccTrack';
vi.mock('../../api/coaccessibility', () => ({ getCoaccArcs: vi.fn(async () => ({ arcs: [] })),
  getCoaccSlice: vi.fn(async () => ({ profile: [] })), getCoaccStripUrl: vi.fn(() => '/strip.png') }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const initial = useBrowserStore.getState(), coacc = useCoaccStore.getState(), split = useSplitPanelStore.getState();
afterEach(() => { useBrowserStore.setState(initial, true); useCoaccStore.setState(coacc, true); useSplitPanelStore.setState(split, true); vi.clearAllMocks(); vi.useRealTimers(); });
it.each(['heatmap', 'arc', 'virtual4c'] as const)('%s requests the split panel reference, locus and reads', async mode => {
  vi.useFakeTimers();
  useCoaccStore.setState({ coaccTrackMode: mode });
  useBrowserStore.setState({ chrom: 'stale', start: 9000, end: 10000, datasets: [{ id: 'd' }, { id: 'other' }],
    panels: [{ id: 'p', contentType: 'dataset', datasetId: 'd', stateKey: 'split', genome: 'own',
      viewportOverride: { chrom: 'copy', start: 100, end: 500 }, readSubset: { rule: { kind: 'frozen', datasetId: 'd', groupKeys: [] } } }],
    selectedDatasets: new Set(), filteredReadIds: {}, clusterFocus: {}, clusterAssignments: {},
  } as never);
  useSplitPanelStore.getState().setReads('split', { state: 'ready', ids: new Set(['read']) } as never);
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(<CoAccTrack panelId="p" width={400} height={80} />));
  await act(async () => { vi.advanceTimersByTime(301); });
  const api = mode === 'arc' ? getCoaccArcs : mode === 'heatmap' ? getCoaccStripUrl : getCoaccSlice;
  const call = vi.mocked(api).mock.calls.at(-1)!;
  expect(call.slice(0, 3)).toEqual(['copy', 100, 500]);
  expect(call.at(-1)).toMatchObject({ panelGenome: 'own', datasetIds: ['d'], readIdsByDataset: { d: ['read'] } });
  act(() => root.unmount());
});
