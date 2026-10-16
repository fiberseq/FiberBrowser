import { beforeEach, describe, expect, it } from 'vitest';
import { createTestStore } from './helpers';

let store: ReturnType<typeof createTestStore>;

const panel = (id: string, extra: Record<string, unknown> = {}) => ({
  id, contentType: 'dataset', datasetId: 'ds1', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, ...extra,
});

beforeEach(() => {
  localStorage.clear();
  store = createTestStore();
  store.setState({
    chrom: '2R', start: 1000, end: 2000,
    datasets: [{ id: 'ds1', label: 'D1' }],
  } as never);
});

describe('cluster snapshots keep each panel its own result', () => {
  it('two independently clustered panels of one dataset come back as they were', () => {
    store.setState({
      panels: [panel('p1', { stateKey: 'p1' }), panel('p2', { stateKey: 'p2' })],
      clusterAssignments: { p1: { r1: 0, r2: 1 }, p2: { r1: 1, r2: 1 } },
      clusterOrder: { p1: [0, 1], p2: [1] },
    } as never);
    store.getState().saveCurrentClustering('snap');
    const saved = store.getState().savedClusters[0];
    store.setState({ clusterAssignments: {}, clusterOrder: {} } as never);
    store.getState().restoreSavedCluster(saved.id);
    expect(store.getState().clusterAssignments.p1).toEqual({ r1: 0, r2: 1 });
    expect(store.getState().clusterAssignments.p2).toEqual({ r1: 1, r2: 1 });
    expect(store.getState().clusterOrder.p2).toEqual([1]);
  });

  it("a copy at its own locus is neither the dataset-level result nor given the main view's", () => {
    store.setState({
      panels: [panel('p1'), panel('far', { stateKey: 'far', viewportOverride: { chrom: '3L', start: 5, end: 500 } })],
      clusterAssignments: { ds1: { r1: 0 }, far: { x1: 3 } },
    } as never);
    store.getState().saveCurrentClustering('snap');
    const saved = store.getState().savedClusters[0];
    expect(saved.assignments.ds1).toEqual({ r1: 0 });
    store.setState({ clusterAssignments: {} } as never);
    store.getState().restoreSavedCluster(saved.id);
    expect(store.getState().clusterAssignments.ds1).toEqual({ r1: 0 });
    expect(store.getState().clusterAssignments.far).toEqual({ x1: 3 });
  });
});

describe('navigation', () => {
  it('discarding the clustering also leaves its active branch', () => {
    store.setState({
      panels: [panel('p1')],
      clusterAssignments: { ds1: { r1: 0 } },
      clusterTreeNodes: { n1: { id: 'n1' } },
      clusterTreeRootIds: ['n1'],
      activeClusterTreeNodeId: 'n1',
    } as never);
    store.getState().setViewport('2R', 50_000, 51_000);
    expect(store.getState().clusterAssignments).toEqual({});
    expect(store.getState().activeClusterTreeNodeId).toBeNull();
  });

  it('bookmark and Back jumps keep a panel at its own locus as it is, and the footprint cart', () => {
    store.setState({
      panels: [panel('p1'), panel('far', { stateKey: 'far', viewportOverride: { chrom: '3L', start: 5, end: 500 } })],
      clusterAssignments: { ds1: { r1: 0 }, far: { x1: 3 } },
      filteredReadIds: { far: new Set(['x1']) },
      footprintGroups: [{ id: 'g1', name: 'A', color: '#f00', sourceIndex: -1, sizeMin: 10, sizeMax: 60, enabled: true, referenceAbsStart: 1100, referenceAbsEnd: 1150, referenceChrom: '2R' }],
    } as never);
    store.getState().addBookmark('here');
    const id = store.getState().bookmarks[store.getState().bookmarks.length - 1].id;
    store.setState({ chrom: 'X', start: 1, end: 900 } as never);
    store.getState().navigateToBookmark(id);
    const st = store.getState();
    expect(st.chrom).toBe('2R');
    expect(st.clusterAssignments.far).toEqual({ x1: 3 });
    expect(st.clusterAssignments.ds1).toBeUndefined();
    expect([...(st.filteredReadIds.far ?? [])]).toEqual(['x1']);
    expect(st.footprintGroups.map(g => g.id)).toEqual(['g1']);
    st.goBack();
    expect(store.getState().chrom).toBe('X');
    expect(store.getState().clusterAssignments.far).toEqual({ x1: 3 });
  });
});
