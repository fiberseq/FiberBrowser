import { beforeEach, describe, expect, it } from 'vitest';
import { createTestStore } from '../stores/__tests__/helpers';
import { clusterBasis, clusterRunPlan, clusterWindows, wholeViewRegion, WHOLE_VIEW_LABEL } from './clusterTargets';
import { deserializeSavedState, remapDatasetIds, serializeState } from '../stores/historySlice';
import { SESSION_POST_VIEWPORT_KEYS } from '../api/session';
import type { BrowserState } from '../stores/browserStore';
import type { ClusterWindowPeaks } from '../types';

let store: ReturnType<typeof createTestStore>;
beforeEach(() => {
  localStorage.clear();
  store = createTestStore();
  store.setState({ chrom: 'chr1', start: 100, end: 900, currentGenome: 'test',
    datasets: [{ id: 'd', label: 'Sample' }], selectedPeaks: new Set(), selectedFeatures: [],
    panels: [{ id: 'p', contentType: 'dataset', datasetId: 'd', subTracks: [], collapsed: false }],
    clusterPeakMode: 'nuc', clusterFeatureRules: [], filteredReadIds: {},
  } as never);
});

describe('whole-view cluster scope', () => {
  it('plans one region in the current feature mode and says so in the tooltip headline', () => {
    const plan = clusterRunPlan(store.getState() as BrowserState);
    expect(plan.refusal).toBeNull();
    expect(plan.basis).toMatchObject({ kind: 'whole-view', scope: 'whole-view', what: WHOLE_VIEW_LABEL,
      regions: [{ start: 100, end: 900, mode: 'nuc', chrom: 'chr1' }] });
    expect(plan.headline).toContain(WHOLE_VIEW_LABEL);
    expect(plan.rows[0].inRun).toBe(true);
  });

  it('uses a targeted split panel\'s own locus and preserves its read filter', () => {
    store.setState({ selectedDatasets: new Set(['p']), filteredReadIds: { 'd:split': new Set(['r1']) },
      panels: [{ id: 'p', stateKey: 'd:split', contentType: 'dataset', datasetId: 'd', subTracks: [], collapsed: false,
        viewportOverride: { chrom: 'chr2', start: 2000, end: 4500 } }] } as never);
    const st = store.getState() as BrowserState;
    const plan = clusterRunPlan(st);
    expect(plan.basis.regions).toEqual([{ start: 2000, end: 4500, mode: 'nuc', chrom: 'chr2' }]);
    const windows = clusterWindows(st, ['d']);
    expect(windows[0].read_ids).toEqual(['r1']);
    expect(wholeViewRegion(windows[0], plan.basis.regions[0].mode)).toEqual({ start: 2000, end: 4500, mode: 'nuc' });
  });

  it('keeps a selected peak and an active empty custom rule authoritative', () => {
    store.setState({ selectedPeaks: new Set([7]), getAllPeaks: () => [{ index: 7, start: 150, end: 200 }], peakModes: { 7: 'tf' } } as never);
    expect(clusterBasis(store.getState() as BrowserState)).toMatchObject({ kind: 'peaks', regions: [{ start: 150, end: 200, mode: 'tf' }] });
    store.setState({ selectedPeaks: new Set(), clusterPeakMode: 'cluster_rule:empty',
      clusterFeatureRules: [{ id: 'empty', name: 'Empty', scope: { kind: 'customRegion', region: { chrom: 'chr2', start: 10, end: 20 } }, terms: [] }] } as never);
    expect(clusterBasis(store.getState() as BrowserState).kind).toBe('none');
  });

  it('records scope and per-panel spans through Undo, session serialization, branch switching and saved clusters', () => {
    const s = () => store.getState();
    const region = { start: 100, end: 900, mode: 'nuc' };
    const windows: ClusterWindowPeaks = { scope: 'whole-view', regions: [region], byKey: { d: [region] },
      views: { d: { chrom: 'chr1', start: 100, end: 900, genome: null } } };
    s().pushSnapshot('Before cluster');
    store.setState({ clusterAssignments: { d: { r1: 0, r2: 1 } }, clusterOrder: { d: [0, 1] }, clusterPeakRegions: [region] } as never);
    s().setClusterWindowPeaks(windows);
    const node = s().captureActiveClusterTreeNode({ name: 'All reads' })!;
    s().pushSnapshot('Whole view cluster');
    s().undo();
    expect(s().clusterWindowPeaks).toBeNull();
    s().redo();
    expect(s().clusterWindowPeaks).toEqual(windows);
    const saved = serializeState(s() as BrowserState);
    const restored = deserializeSavedState(JSON.parse(JSON.stringify(saved)));
    expect(restored.clusterWindowPeaks).toEqual(windows);
    expect(restored.clusterTreeNodes![node].windowPeaks).toEqual(windows);
    expect(SESSION_POST_VIEWPORT_KEYS).toContain('clusterWindowPeaks');
    const remapped = deserializeSavedState(remapDatasetIds(saved, { d: 'reopened' }));
    expect(remapped.clusterWindowPeaks?.scope).toBe('whole-view');
    expect(remapped.clusterWindowPeaks?.byKey.reopened).toEqual([region]);
    expect(remapped.clusterTreeNodes![node].windowPeaks?.byKey.reopened).toEqual([region]);
    store.setState({ clusterWindowPeaks: null });
    s().applyClusterTreeNode(node);
    expect(s().clusterWindowPeaks).toEqual(windows);
    s().setClusterWindowPeaks({ ...windows, scope: undefined });
    expect(s().clusterTreeNodes[node].windowPeaks?.scope).toBeUndefined();
    s().setClusterWindowPeaks(windows);
    s().saveCurrentClustering('Whole view');
    s().setClusterWindowPeaks(null);
    s().restoreSavedCluster(s().savedClusters[0].id);
    expect(s().clusterWindowPeaks).toEqual(windows);
  });
});
