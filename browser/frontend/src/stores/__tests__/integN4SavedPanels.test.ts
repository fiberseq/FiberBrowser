/**
 * fb-n4-integ (Codex integ 4 and 6).
 *
 * 4. Restoring a saved clustering takes a panel saved at a locus of its own
 *    back there (the stale main locus still matched, so the panel stayed where
 *    it had moved, without its saved clusters).
 * 6. A run over panels at several loci keeps each panel's own matched peaks
 *    (clusterWindowPeaks) with the view it was clustered at; snapshots,
 *    sessions, crash recovery and saved clusterings now keep them too, so
 *    the reopened charts don't fall back to the first window's peaks.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestStore } from './helpers';
import { deserializeSavedState, remapDatasetIds, serializeState } from '../historySlice';
import { clusterChartRunPeaks } from '../../components/controls/cluster-detail/clusterChartScope';

let store: ReturnType<typeof createTestStore>;
const panel = (id: string, datasetId: string, over: Record<string, unknown> = {}) =>
  ({ id, contentType: 'dataset', datasetId, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, ...over });

const OWN = { chrom: 'chr1', start: 5000, end: 6000 };
const windowPeaks = {
  regions: [{ start: 1200, end: 1250, mode: 'accessibility' }],
  byKey: { 'ds1': [{ start: 1200, end: 1250, mode: 'accessibility' }], 'ds1:copy': [{ start: 5200, end: 5250, mode: 'accessibility' }] },
  views: {
    'ds1': { chrom: 'chr1', start: 1000, end: 2000, genome: null },
    'ds1:copy': { ...OWN, genome: null },
  },
};

beforeEach(() => {
  localStorage.clear();
  store = createTestStore();
  store.setState({
    chrom: 'chr1', start: 1000, end: 2000, navigationMode: 'perPanel',
    datasets: [{ id: 'ds1', label: 'D1' }],
    panels: [panel('p1', 'ds1'), panel('p2', 'ds1', { stateKey: 'ds1:copy', viewportOverride: { ...OWN }, navOwn: true })],
    clusterAssignments: { ds1: { r1: 0, r2: 1 }, 'ds1:copy': { r7: 1, r8: 0 } },
    clusterOrder: { ds1: [0, 1], 'ds1:copy': [1, 0] },
    clusterPeakRegions: windowPeaks.regions,
    clusterWindowPeaks: windowPeaks,
  } as never);
});

describe('4. restoring a saved clustering returns its independent panels', () => {
  it('a panel moved after the save goes back to its saved locus and gets its saved clusters', () => {
    store.getState().saveCurrentClustering('two loci');
    const saved = store.getState().savedClusters[0];
    expect(saved.panelResults?.find(r => r.stateKey === 'ds1:copy')?.viewport).toEqual(OWN);

    // The copy panel moves elsewhere (its clusters are cleared); the main locus stays.
    store.getState().navigatePanel('p2', 'chr2', 10_000, 11_000);
    expect(store.getState().clusterAssignments['ds1:copy'] ?? {}).toEqual({});

    store.getState().restoreSavedCluster(saved.id);
    const st = store.getState();
    expect(st.panels.find(p => p.id === 'p2')?.viewportOverride).toEqual(OWN);
    expect(st.clusterAssignments['ds1:copy']).toEqual({ r7: 1, r8: 0 });
    expect(st.clusterOrder['ds1:copy']).toEqual([1, 0]);
    expect(st.clusterAssignments.ds1).toEqual({ r1: 0, r2: 1 });
  });

  it('is one undo step: Undo goes back to before it, Redo brings the panel and its clusters back (Codex review)', () => {
    store.getState().saveCurrentClustering('two loci');
    const saved = store.getState().savedClusters[0];
    store.getState().navigatePanel('p2', 'chr2', 10_000, 11_000);
    store.getState().restoreSavedCluster(saved.id);
    expect(store.getState()._historyStack.at(-1)?.label).toBe('Restore clustering two loci');
    expect(store.getState()._historyStack.some(e => e.label.startsWith('Panel to chr1'))).toBe(false);
    store.getState().undo();
    expect(store.getState().panels.find(p => p.id === 'p2')?.viewportOverride).toEqual({ chrom: 'chr2', start: 10_000, end: 11_000 });
    store.getState().redo();
    expect(store.getState().panels.find(p => p.id === 'p2')?.viewportOverride).toEqual(OWN);
    expect(store.getState().clusterAssignments['ds1:copy']).toEqual({ r7: 1, r8: 0 });
  });

  it('saved in Each panel navigates, restored in Linked navigation: switches back so panels go to their own loci (Codex review)', () => {
    store.getState().saveCurrentClustering('two loci');
    const saved = store.getState().savedClusters[0];
    // Linked navigation: the copy follows the main view again.
    store.setState({ navigationMode: 'linked', panels: [panel('p1', 'ds1'), panel('p2', 'ds1', { stateKey: 'ds1:copy' })], clusterAssignments: {} } as never);
    store.getState().restoreSavedCluster(saved.id);
    const st = store.getState();
    expect(st.navigationMode).toBe('perPanel');
    expect(st.panels.find(p => p.id === 'p2')?.viewportOverride).toEqual(OWN);
    expect(st.clusterAssignments['ds1:copy']).toEqual({ r7: 1, r8: 0 });
  });

  it('a panel now on another reference is not moved, and does not take the saved result', () => {
    store.setState({ panels: [panel('p1', 'ds1'), panel('p2', 'ds1', { stateKey: 'ds1:copy', genome: 'dm6', viewportOverride: { ...OWN } })] } as never);
    store.getState().saveCurrentClustering('dm6');
    const saved = store.getState().savedClusters[0];
    expect(saved.panelResults?.find(r => r.stateKey === 'ds1:copy')?.genome).toBe('dm6');
    store.setState({
      panels: [panel('p1', 'ds1'), panel('p2', 'ds1', { stateKey: 'ds1:copy', viewportOverride: { chrom: 'chr2', start: 1, end: 900 } })],
      clusterAssignments: {},
    } as never);
    store.getState().restoreSavedCluster(saved.id);
    expect(store.getState().panels.find(p => p.id === 'p2')?.viewportOverride).toEqual({ chrom: 'chr2', start: 1, end: 900 });
    expect(store.getState().clusterAssignments['ds1:copy']).toBeUndefined();
  });
});

describe('6. each window\'s own peaks are kept', () => {
  it('in snapshots, sessions and crash recovery', () => {
    const serialized = serializeState(store.getState() as never);
    expect(serialized.clusterWindowPeaks).toEqual(windowPeaks);
    const back = deserializeSavedState(JSON.parse(JSON.stringify(serialized)));
    expect(back.clusterWindowPeaks).toEqual(windowPeaks);
  });

  it('under a reopened dataset\'s new id', () => {
    const serialized = serializeState(store.getState() as never);
    const moved = remapDatasetIds(serialized, { ds1: 'ds9' });
    expect(Object.keys(moved.clusterWindowPeaks!.byKey).sort()).toEqual(['ds9', 'ds9:copy']);
    expect(Object.keys(moved.clusterWindowPeaks!.views!).sort()).toEqual(['ds9', 'ds9:copy']);
  });

  it('in a saved clustering, under a reopened dataset\'s new id (its results and window peaks; Codex review)', () => {
    store.getState().saveCurrentClustering('two loci');
    const moved = remapDatasetIds(serializeState(store.getState() as never), { ds1: 'ds9' });
    const saved = moved.savedClusters![0] as { assignments: Record<string, unknown>; windowPeaks: { byKey: object; views: object }; panelResults: Array<{ stateKey: string }> };
    expect(Object.keys(saved.assignments)).toEqual(['ds9']);
    expect(Object.keys(saved.windowPeaks.byKey).sort()).toEqual(['ds9', 'ds9:copy']);
    expect(Object.keys(saved.windowPeaks.views).sort()).toEqual(['ds9', 'ds9:copy']);
    expect(saved.panelResults.map(r => r.stateKey).sort()).toEqual(['ds9', 'ds9:copy']);
  });

  it('in a saved clustering, restored with it', () => {
    store.getState().saveCurrentClustering('two loci');
    const saved = store.getState().savedClusters[0];
    expect(saved.windowPeaks).toEqual(windowPeaks);
    store.setState({ clusterWindowPeaks: null } as never);
    store.getState().restoreSavedCluster(saved.id);
    expect(store.getState().clusterWindowPeaks).toEqual(windowPeaks);
  });

  it('after reopening, the copy panel\'s charts use its own peaks (not the first window\'s, outside its view)', () => {
    const back = deserializeSavedState(JSON.parse(JSON.stringify(serializeState(store.getState() as never))));
    const peaks = clusterChartRunPeaks(back.clusterPeakRegions!, back.clusterWindowPeaks ?? null, ['ds1:copy'], { ...OWN, genome: null }, 'chr1');
    expect(peaks).toEqual([{ start: 5200, end: 5250, mode: 'accessibility' }]);
  });

  it('only on the view\'s reference: a panel now on another assembly at the same coordinates doesn\'t take them', () => {
    const peaks = clusterChartRunPeaks(windowPeaks.regions, windowPeaks, ['ds1:copy'], { ...OWN, genome: 'dm6' }, 'chr1');
    expect(peaks).not.toEqual([{ start: 5200, end: 5250, mode: 'accessibility' }]);
  });
});
