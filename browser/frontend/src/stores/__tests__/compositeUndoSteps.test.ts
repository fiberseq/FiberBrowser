/**
 * Stabilize 3, item 2: actions that change clusters in several steps record one undo step. `setClusterFocus` records a
 * step of its own; inside a larger action (membership clusters, dissolve, merge, hide) it took an extra Undo, or was
 * the only step the action recorded. Each action also seeds its own baseline, so the first one after Clear history can
 * be undone (Codex stabilize-2 review, round 1).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore, type BrowserState } from '../browserStore';
import { applyMembershipClusters } from '../../utils/footprintMembership';

vi.mock('../../utils/copilotAnchors', () => ({ highlightForAction: vi.fn(async () => undefined), COPILOT_ANCHORS: {} }));

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const labels = () => useBrowserStore.getState()._historyStack.map(x => x.label);
/** Later clicks: never coalesced with the steps before them by time. */
const age = () => useBrowserStore.setState(s => ({ _historyStack: s._historyStack.map(x => ({ ...x, timestamp: x.timestamp - 10_000 })) }));

function seedClusters(focus: Set<number> | null) {
  useBrowserStore.setState({
    chrom: 'chr1', start: 1000, end: 2000,
    datasets: [{ id: 'ds1', label: 'One', available_layers: { tf: true, nuc: true } }],
    panels: [{ id: 'p1', contentType: 'dataset', datasetId: 'ds1', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 }],
    selectedDatasets: new Set<string>(),
    _historyStack: [], _historyPointer: -1, _lastRestoreTime: 0,
  } as unknown as Partial<BrowserState>);
  const s = useBrowserStore.getState();
  s.setClusterAssignments('ds1', { a: 0, b: 1, c: 2 });
  s.setClusterOrder('ds1', [0, 1, 2]);
  useBrowserStore.setState({ clusterFocus: { ds1: focus }, clusterPeakRegions: [{ start: 1100, end: 1200, mode: 'tf' }], dynamicClustering: true });
  useBrowserStore.getState().pushSnapshot('Cluster reads', { kind: 'clustering' });
  age();
}

describe('one undo step per cluster action (stabilize 3, item 2)', () => {
  let initial: BrowserState;
  beforeEach(async () => {
    initial = useBrowserStore.getState();
    useBrowserStore.setState(useBrowserStore.getInitialState(), true);
  });
  afterEach(() => { vi.unstubAllGlobals(); useBrowserStore.setState(initial, true); });

  const membership = () => applyMembershipClusters(
    { byDataset: { ds1: { a: 1, b: 0, c: 0 } }, patterns: ['10', '01'], legend: [] },
    [{ id: 'A', name: 'A', sourceIndex: -1, sizeMin: 0, sizeMax: null, referenceAbsStart: 1100, referenceAbsEnd: 1150 },
      { id: 'B', name: 'B', sourceIndex: -1, sizeMin: 0, sizeMax: null, referenceAbsStart: 1160, referenceAbsEnd: 1190 }] as never,
    { ds1: ['ds1'] }, 1000);

  it('Cluster by footprints is one step; one Undo brings back the grouping and focus before it', () => {
    seedClusters(new Set([1]));
    const before = labels().length;
    membership();
    expect(labels().slice(before)).toEqual(['Cluster by footprints']);
    useBrowserStore.getState().undo();
    const s = useBrowserStore.getState();
    expect(s.clusterAssignments.ds1).toEqual({ a: 0, b: 1, c: 2 });
    expect([...(s.clusterFocus.ds1 ?? [])]).toEqual([1]);
  });

  it('the first Cluster by footprints after Clear history can be undone to the grouping before it', () => {
    seedClusters(null);
    useBrowserStore.getState().clearHistory();
    membership();
    const s = useBrowserStore.getState();
    expect(s.canUndo()).toBe(true);
    s.undo();
    expect(useBrowserStore.getState().clusterAssignments.ds1).toEqual({ a: 0, b: 1, c: 2 });
  });

  it.each([
    ['dissolve_cluster', { type: 'dissolve_cluster', cluster_id: 1 }, { results: { ds1: { assignments: { a: 0, b: 0, c: 2 } } } }, 'Delete C1'],
    ['auto_cull_clusters', { type: 'auto_cull_clusters' }, { results: { ds1: { assignments: { a: 0, b: 0, c: 2 } } }, dissolved: [{ cluster: 1, count: 1, reason: 'small' }] }, 'Merge similar clusters'],
  ])('Copilot %s records one step, focused or not, and one Undo takes it back', async (_name, action, response, label) => {
    const { executeBrowserAction } = await import('../../actions/browserActions');
    for (const focus of [new Set([1]), null]) {
      seedClusters(focus);
      vi.stubGlobal('fetch', vi.fn(async () => ok(response)));
      const before = labels().length;
      await executeBrowserAction(action);
      expect(labels().slice(before)).toEqual([label]);
      expect(useBrowserStore.getState().dynamicClustering).toBe(false);
      useBrowserStore.getState().undo();
      const s = useBrowserStore.getState();
      expect(s.clusterAssignments.ds1).toEqual({ a: 0, b: 1, c: 2 });
      expect(s.clusterFocus.ds1 ? [...s.clusterFocus.ds1] : null).toEqual(focus ? [...focus] : null);
      expect(s.dynamicClustering).toBe(true);
    }
  });

  it.each(['dissolve_cluster', 'auto_cull_clusters'])('the first Copilot %s after Clear history can be undone', async (type) => {
    const { executeBrowserAction } = await import('../../actions/browserActions');
    seedClusters(new Set([1]));
    useBrowserStore.getState().clearHistory();
    vi.stubGlobal('fetch', vi.fn(async () => ok({ results: { ds1: { assignments: { a: 0, b: 0, c: 2 } } }, dissolved: [{ cluster: 1, count: 1, reason: 'small' }] })));
    await executeBrowserAction({ type, cluster_id: 1 });
    const s = useBrowserStore.getState();
    expect(s.canUndo()).toBe(true);
    s.undo();
    expect(useBrowserStore.getState().clusterAssignments.ds1).toEqual({ a: 0, b: 1, c: 2 });
  });

  it('Codex B r1: a Copilot dissolve whose second round fails keeps what the first applied undoable, as one step', async () => {
    const { executeBrowserAction } = await import('../../actions/browserActions');
    const panel = (id: string, stateKey: string) => ({ id, stateKey, datasetId: 'ds1', contentType: 'dataset', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 });
    useBrowserStore.setState({
      chrom: 'chr1', start: 1000, end: 2000,
      datasets: [{ id: 'ds1', label: 'One', available_layers: { tf: true, nuc: true } }],
      panels: [panel('p1', 'first'), panel('p2', 'second')], selectedDatasets: new Set(),
      clusterAssignments: { first: { a: 0, b: 1, c: 2 }, second: { a: 0, b: 1, c: 2 } },
      clusterOrder: { first: [0, 1, 2], second: [0, 1, 2] },
      clusterFocus: { first: new Set([1]), second: new Set([1]) },
      clusterPeakRegions: [{ start: 1100, end: 1200, mode: 'tf' }], dynamicClustering: true,
      _historyStack: [], _historyPointer: -1, _lastRestoreTime: 0,
    } as never);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(ok({ results: { ds1: { assignments: { a: 0, b: 0, c: 2 } } } }))
      .mockRejectedValueOnce(new Error('second round failed')));
    await expect(executeBrowserAction({ type: 'dissolve_cluster', cluster_id: 1 })).rejects.toThrow('second round failed');
    const s = useBrowserStore.getState();
    expect(s.clusterAssignments.first.b).toBe(0);
    expect(labels().filter(l => !l.startsWith('Before '))).toEqual(['Delete C1']);
    expect(s.dynamicClustering).toBe(false);
    s.undo();
    expect(useBrowserStore.getState().clusterAssignments.first.b).toBe(1);
  });

  it('Copilot focus_cluster over two panels is one step', async () => {
    const { executeBrowserAction } = await import('../../actions/browserActions');
    seedClusters(null);
    useBrowserStore.setState(s => ({ panels: [...s.panels, { ...s.panels[0], id: 'p2', stateKey: 'p2' }],
      selectedDatasets: new Set(['p1', 'p2']) }) as never);
    useBrowserStore.getState().setClusterAssignments('p2', { a: 0, b: 1 });
    useBrowserStore.getState().pushSnapshot('Copy clusters', { kind: 'clustering' });
    age();
    const before = labels().length;
    await executeBrowserAction({ type: 'focus_cluster', cluster_id: 1 });
    expect(labels().slice(before)).toEqual(['Focus cluster 1']);
    const s = useBrowserStore.getState();
    expect([...(s.clusterFocus.ds1 ?? [])]).toEqual([1]);
    expect([...(s.clusterFocus.p2 ?? [])]).toEqual([1]);
    s.undo();
    expect(useBrowserStore.getState().clusterFocus.p2 ?? null).toBeNull();
  });

  it('Copilot hide_cluster is one step', async () => {
    const { executeBrowserAction } = await import('../../actions/browserActions');
    seedClusters(null);
    const before = labels().length;
    await executeBrowserAction({ type: 'hide_cluster', cluster_id: 1, dataset_id: 'ds1' });
    expect(labels().slice(before)).toEqual(['Hide cluster 1']);
    useBrowserStore.getState().undo();
    expect(useBrowserStore.getState().clusterFocus.ds1 ?? null).toBeNull();
  });
});
