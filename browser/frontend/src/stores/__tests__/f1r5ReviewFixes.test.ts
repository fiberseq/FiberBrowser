import { beforeEach, describe, expect, it } from 'vitest';
import { createTestStore } from './helpers';
import { applyImportedState } from '../../api/session';
import { useBrowserStore } from '../browserStore';

let store: ReturnType<typeof createTestStore>;

const track = (type: string) => ({ type, visible: true });
const panel = (id: string, subTracks: Array<{ type: string; visible: boolean }>, extra: Record<string, unknown> = {}) => ({
  id, contentType: 'dataset', datasetId: 'ds1', subTracks, collapsed: false, linkGroup: 'g1', layoutRow: 0, ...extra,
});

beforeEach(() => {
  localStorage.clear();
  store = createTestStore();
  store.setState({ chrom: '2R', start: 1000, end: 2000, datasets: [{ id: 'ds1', label: 'D1' }] } as never);
});

describe('reordering tracks in linked panels', () => {
  it('moves the same track in each panel, even when their track lists differ', () => {
    store.setState({
      panels: [
        panel('a', [track('axis'), track('sequence'), track('genes'), track('reads')]),
        panel('b', [track('axis'), track('genes'), track('reads')]),
      ],
    } as never);
    // Drag panel A's last track (reads) up to where genes is.
    store.getState().reorderSubTracks('a', 3, 2);
    const [a, b] = store.getState().panels;
    expect(a.subTracks.map(t => t.type)).toEqual(['axis', 'sequence', 'reads', 'genes']);
    expect(b.subTracks.map(t => t.type)).toEqual(['axis', 'reads', 'genes']);
    expect(b.subTracks.every(Boolean)).toBe(true);
  });

  it('leaves a linked panel without the moved track as it is', () => {
    store.setState({
      panels: [
        panel('a', [track('axis'), track('sequence'), track('reads')]),
        panel('b', [track('axis'), track('reads')]),
      ],
    } as never);
    store.getState().reorderSubTracks('a', 1, 0);
    const [a, b] = store.getState().panels;
    expect(a.subTracks.map(t => t.type)).toEqual(['sequence', 'axis', 'reads']);
    expect(b.subTracks.map(t => t.type)).toEqual(['axis', 'reads']);
  });
});

describe('merging clusters by hand', () => {
  it('turns dynamic reassignment off, live and in the active branch', () => {
    store.setState({
      clusterAssignments: { ds1: { r1: 0, r2: 1 } },
      clusterOrder: { ds1: [0, 1] },
      clusterPatterns: { 0: [1, 0], 1: [0, 1] },
      dynamicClustering: true,
    } as never);
    const nodeId = store.getState().captureActiveClusterTreeNode({ name: 'root' });
    expect(nodeId).toBeTruthy();
    expect(store.getState().activeClusterTreeNodeId).toBe(nodeId);
    expect(store.getState().clusterTreeNodes[nodeId!].dynamicClustering).toBe(true);
    store.getState().setClusterSelection('ds1', [0, 1]);
    expect(store.getState().mergeSelectedClusters(['ds1'])).toBe(1);
    expect(store.getState().dynamicClustering).toBe(false);
    expect(store.getState().clusterTreeNodes[nodeId!].dynamicClustering).toBe(false);
  });
});

describe('importing a session saved before the track cart', () => {
  it('drops the previous session\'s catalog and composite tracks', () => {
    useBrowserStore.setState({
      catalog: [{ id: 'old', kind: 'bigwig', label: 'Old signal', pathOrUrl: '/old.bw', source: 'local', addedAt: 1 }],
      compositeTracks: [{ id: 'c-old', label: 'Old', kind: 'signal', sources: [], scaleMode: 'auto', logScale: false, visible: true, groupAutoscaleSelected: false, showAxes: true }],
    } as never);
    applyImportedState({
      datasets: [], overlays: [], has_fasta: false,
      frontend: { clickTargetLayer: 'tf' },
      viewport: { chrom: 'chr2R', start: 1000, end: 2000 },
    });
    expect(useBrowserStore.getState().catalog).toEqual([]);
    expect(useBrowserStore.getState().compositeTracks).toEqual([]);
  });
});
