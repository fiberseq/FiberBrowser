import { beforeEach, describe, expect, it } from 'vitest';
import { createTestStore } from './helpers';
import { annotationViewportKey } from '../annotationSlice';

let store: ReturnType<typeof createTestStore>;

beforeEach(() => {
  localStorage.clear();
  store = createTestStore();
  store.setState({ chrom: '2R', start: 1000, end: 2000, datasets: [{ id: 'ds1', label: 'D1' }] } as never);
});

describe('restoring a saved clustering', () => {
  it('comes back whole: no focus, selection, branch or centroid model left from before', () => {
    store.setState({
      panels: [{ id: 'p1', contentType: 'dataset', datasetId: 'ds1', subTracks: [], collapsed: false, layoutRow: 0 }],
      clusterAssignments: { ds1: { r1: 0, r2: 1, r3: 2 } },
      clusterOrder: { ds1: [0, 1, 2] },
    } as never);
    store.getState().saveCurrentClustering('three');
    const savedId = store.getState().savedClusters[0].id;
    // A child branch focused on cluster 0, with its own centroid model.
    store.setState({
      clusterAssignments: { ds1: { r1: 0 } },
      clusterFocus: { ds1: new Set([0]) },
      selectedClusters: { ds1: new Set([0]) },
      activeClusterTreeNodeId: 'child',
      clusterCentroids: { 0: [1, 0] },
      clusterPeakWidths: [2],
    } as never);
    store.getState().restoreSavedCluster(savedId);
    const st = store.getState();
    expect(st.clusterAssignments.ds1).toEqual({ r1: 0, r2: 1, r3: 2 });
    expect(st.clusterFocus.ds1 ?? null).toBeNull();
    expect(st.selectedClusters.ds1).toBeUndefined();
    expect(st.activeClusterTreeNodeId).toBeNull();
    expect(st.clusterCentroids).toEqual({});
    expect(st.restoredClusterViewport).toEqual({ chrom: '2R', start: 1000, end: 2000 });
  });
});

describe('drawing a custom peak', () => {
  it('records the chromosome of the pending start, cleared with it', () => {
    store.getState().setPeakDrawStart(1500, 'chr1');
    expect(store.getState().peakDrawChrom).toBe('chr1');
    store.getState().setPeakDrawStart(null);
    expect(store.getState().peakDrawChrom).toBeNull();
    store.getState().setPeakDrawStart(1500, 'chr1');
    store.getState().setPeakDrawMode(false);
    expect(store.getState().peakDrawStart).toBeNull();
    expect(store.getState().peakDrawChrom).toBeNull();
  });
});

describe('main-view annotation overlays', () => {
  it('remember the view they were fetched for', () => {
    store.getState().setAnnotationOverlays({ r1: [] }, {}, annotationViewportKey('2R', 1000, 2000));
    expect(store.getState().annotationOverlaysViewport).toBe('2R:1000-2000');
    store.getState().clearAnnotationOverlays();
    expect(store.getState().annotationOverlaysViewport).toBeNull();
  });
});
