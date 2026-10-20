import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../../stores/browserStore';
import { useReadActionsStore } from '../../../stores/readActionsStore';
import { useLiveLiftStore } from '../../../features/liveLift/store';
import { useDifferenceSelection } from '../../../features/differences/selectionStore';
import { getDifferences } from '../../../features/liveLift/api';
import type { CompactRead } from './types';
import { useReadTrackMouse } from './useReadTrackMouse';

vi.mock('../../../features/liveLift/api', async orig => ({ ...(await orig<typeof import('../../../features/liveLift/api')>()), getDifferences: vi.fn() }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// ⌘/Ctrl-click on a live-lift read's mismatch inspects it (the click table in docs/DIFFERENCES_WORKSPACE.md);
// on a native read it still picks a footprint.
const lifted = { id: 'r', intervals: [[0, 1000, -1000]], cigar: [{ type: 'X', pos: 500, base: 'G', ref: 'A', len: 1 }],
  live_lift: { v: 1, hap: 'h1', hap_label: 'MAT', segments: [[0, 1000, 0, '+', true]], badges: [] } } as unknown as CompactRead;
let handlers: ReturnType<typeof useReadTrackMouse> | null = null;
let reads: CompactRead[] = [lifted];
function Harness() {
  handlers = useReadTrackMouse({ displayReads: reads, width: 1000, height: 200, sidebarWidth: 0, regionWidth: 1000, start: 0, end: 1000,
    chrom: 'chr1', datasetId: 'lift', stateKey: 'mat-state', hasCluster: false, myClusterAssignments: {}, myClusterOrder: [],
    myClusterFocus: null, mySelectedClusters: null, hasClusterFocus: false, isPanning: false, isReversed: false, fillReadHeight: false,
    storeReadRowHeight: 20, readScrollOffset: 0, readSeparatorMode: 'off', readSeparatorMinHeight: 0, readSeparatorWidth: 0,
    showReadTooltip: false, showCoverageHistogram: false } as never);
  return null;
}
let root: Root; let host: HTMLDivElement;
const canvas = document.createElement('canvas');
Object.defineProperty(canvas, 'clientWidth', { value: 1000 });
Object.defineProperty(canvas, 'clientHeight', { value: 200 });
canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 200 } as DOMRect);
const click = (mod: boolean) => act(() => handlers!.handleClick({ currentTarget: canvas, clientX: 500, clientY: 8, shiftKey: false,
  ctrlKey: mod, metaKey: mod, detail: 1 } as never));
beforeEach(() => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  useReadActionsStore.getState().reset(); useDifferenceSelection.getState().select(null);
  useLiveLiftStore.setState({ enabled: true });
  vi.mocked(getDifferences).mockReset().mockResolvedValue({ dataset_id: 'lift', lift_key: 'k', chrom: 'chr1', start: 0, end: 1000, mode: 'items', items: [], bins: [], bin_bp: null, novel: [] });
  useBrowserStore.setState({ chrom: 'chr1', start: 0, end: 1000, enabledCigarTypes: { mismatches: true },
    panels: [{ id: 'mat', contentType: 'dataset', datasetId: 'lift', stateKey: 'mat-state', subTracks: [], collapsed: false, linkGroup: null }],
    datasets: [{ id: 'lift', path: '/a.bam', label: 'lift', color: '#000', data_type: 'bam_livelift', live_lift: { key: 'k', haplotypes: ['h1'], haplotype_labels: { h1: 'MAT' } } }] } as never);
});
afterEach(() => { act(() => root.unmount()); host.remove(); reads = [lifted]; });

it('⌘/Ctrl-click on a lifted mismatch opens its inspector, with the read\'s base as the edit', async () => {
  act(() => root.render(<Harness />));
  click(true);
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  const s = useDifferenceSelection.getState().selection;
  expect(s?.difference.kind).toBe('snv');
  expect(s?.difference.alt).toBe('G');
  expect(s?.inspect).not.toBe(false);
});

it('on a native read the same click still picks a footprint, not a difference', async () => {
  reads = [{ id: 'n', intervals: [[0, 1000, -1000]], cigar: [{ type: 'X', pos: 500, base: 'G', ref: 'A', len: 1 }] } as unknown as CompactRead];
  act(() => root.render(<Harness />));
  click(true);
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  expect(useDifferenceSelection.getState().selection).toBeNull();
  expect(getDifferences).not.toHaveBeenCalled();
});
