import { describe, it, expect, beforeEach } from 'vitest';
import { createTestStore } from './helpers';

let store: ReturnType<typeof createTestStore>;

beforeEach(() => {
  localStorage.clear();
  store = createTestStore();
});

// ============================================================================
// togglePeakSelection
// ============================================================================

describe('togglePeakSelection', () => {
  it('selects a peak', () => {
    store.getState().togglePeakSelection(0);
    expect(store.getState().selectedPeaks.has(0)).toBe(true);
  });

  it('deselects an already-selected peak', () => {
    store.getState().togglePeakSelection(0);
    store.getState().togglePeakSelection(0);
    expect(store.getState().selectedPeaks.has(0)).toBe(false);
  });

  it('accumulates multiple selections', () => {
    store.getState().togglePeakSelection(0);
    store.getState().togglePeakSelection(1);
    store.getState().togglePeakSelection(2);
    expect(store.getState().selectedPeaks.size).toBe(3);
  });

  it('applies default mode when selecting', () => {
    store.setState({ clusterPeakMode: 'modification' });
    store.getState().togglePeakSelection(0, 'modification');
    expect(store.getState().peakModes[0]).toBe('modification');
  });

  it('inherits the visible cluster mode instead of a caller fallback', () => {
    store.setState({ clusterPeakMode: 'tf' });

    store.getState().togglePeakSelection(0, 'accessibility');

    expect(store.getState().peakModes[0]).toBe('tf');
  });

  it('clears a stale mode when the visible mode is accessibility', () => {
    store.setState({
      clusterPeakMode: 'accessibility',
      peakModes: { 0: 'tf' },
    });

    store.getState().togglePeakSelection(0, 'accessibility');

    expect(store.getState().selectedPeaks.has(0)).toBe(true);
    expect(store.getState().peakModes[0]).toBeUndefined();
  });

  it('keeps the modification-only fallback when accessibility is only the initial default', () => {
    store.setState({
      clusterPeakMode: 'accessibility',
      datasets: [{
        id: 'mod-only',
        label: 'mod-only',
        path: '/tmp/mod-only.bam',
        color: '#111111',
        data_type: 'bam',
        available_layers: { mod: true },
      }],
    });

    store.getState().togglePeakSelection(0);

    expect(store.getState().peakModes[0]).toBe('modification');
  });

  it('replaces a selection using the visible mode and drops old modes', () => {
    store.setState({
      clusterPeakMode: 'tf',
      selectedPeaks: new Set([0]),
      peakModes: { 0: 'nuc' },
    });

    store.getState().replacePeakSelection([1]);

    expect([...store.getState().selectedPeaks]).toEqual([1]);
    expect(store.getState().peakModes).toEqual({ 1: 'tf' });
  });

  it('uses the caller fallback while a cluster feature rule owns the global mode', () => {
    store.setState({ clusterPeakMode: 'cluster_rule:short_tf' });

    store.getState().togglePeakSelection(0, 'modification');

    expect(store.getState().peakModes[0]).toBe('modification');
  });

  it('removes mode when deselecting', () => {
    store.getState().togglePeakSelection(0, 'tf');
    store.getState().togglePeakSelection(0);
    expect(store.getState().peakModes[0]).toBeUndefined();
  });

  it('accessibility mode is not stored in peakModes (default)', () => {
    store.getState().togglePeakSelection(0, 'accessibility');
    expect(store.getState().peakModes[0]).toBeUndefined();
    expect(store.getState().selectedPeaks.has(0)).toBe(true);
  });
});

// ============================================================================
// cyclePeakMode
// ============================================================================

describe('cyclePeakMode', () => {
  it('cycles accessibility -> tf -> modification -> fire -> accessibility (with allowTf)', () => {
    store.setState({ peakModes: {} });
    store.getState().cyclePeakMode(0, true);
    expect(store.getState().peakModes[0]).toBe('tf');
    store.getState().cyclePeakMode(0, true);
    expect(store.getState().peakModes[0]).toBe('modification');
    store.getState().cyclePeakMode(0, true);
    expect(store.getState().peakModes[0]).toBe('fire');
    store.getState().cyclePeakMode(0, true);
    expect(store.getState().peakModes[0]).toBeUndefined(); // back to accessibility
  });

  it('skips tf when allowTf=false', () => {
    store.setState({ peakModes: {} });
    store.getState().cyclePeakMode(0, false);
    expect(store.getState().peakModes[0]).toBe('modification');
    store.getState().cyclePeakMode(0, false);
    expect(store.getState().peakModes[0]).toBe('fire');
    store.getState().cyclePeakMode(0, false);
    expect(store.getState().peakModes[0]).toBeUndefined(); // back to accessibility
  });

  it('uses canonical layer modes when datasets expose v3 layers', () => {
    store.setState({
      peakModes: {},
      datasets: [{
        id: 'primary',
        label: 'primary',
        path: '/tmp/primary.bam',
        color: '#111111',
        data_type: 'bam',
        available_layers: { nuc: true, tf: true, msp: true },
      }],
    });

    store.getState().cyclePeakMode(0, true);
    expect(store.getState().peakModes[0]).toBe('tf');
    store.getState().cyclePeakMode(0, true);
    expect(store.getState().peakModes[0]).toBe('modification');
    store.getState().cyclePeakMode(0, true);
    expect(store.getState().peakModes[0]).toBe('fire');
    store.getState().cyclePeakMode(0, true);
    expect(store.getState().peakModes[0]).toBe('nuc');
    store.getState().cyclePeakMode(0, true);
    expect(store.getState().peakModes[0]).toBeUndefined();
  });
});

// ============================================================================
// footprintGroups
// ============================================================================

describe('footprintGroups', () => {
  it('normalizes legacy MSP aliases when adding and updating cart groups', () => {
    store.getState().addFootprintGroup({
      name: 'Legacy MSP',
      color: '#f97316',
      layer: 'msp',
      sourceIndex: -1,
      sizeMin: 1,
      sizeMax: 80,
      overlapFraction: 0,
      enabled: true,
    });

    const first = store.getState().footprintGroups[0];
    expect(first.layer).toBe('fire');

    store.getState().updateFootprintGroup(first.id, { layer: 'msp' });

    expect(store.getState().footprintGroups[0].layer).toBe('fire');
  });

  it('keeps family inspection separate from filtering and clears it on removal', () => {
    const family = {
      id: 'family-1', name: 'F001', color: '#123456', layer: 'tf_sr', familyId: 1,
      autoGeneratedFamily: true, sourceViewKey: 'panel-1', sourceDatasetId: 'ds1',
      sourceIndex: -1, sizeMin: 0, sizeMax: null, overlapFraction: 0,
      referenceAbsStart: 100, referenceAbsEnd: 130, enabled: true,
    };
    store.getState().setFootprintGroups([family]);
    store.getState().setSelectedFamilyGroupId(family.id);

    expect(store.getState().selectedFamilyGroupId).toBe(family.id);
    expect(store.getState().footprintFilterKey).toBeNull();

    store.getState().removeFootprintGroup(family.id);
    expect(store.getState().selectedFamilyGroupId).toBeNull();
  });
});

// ============================================================================
// clusterFeatureRules
// ============================================================================

describe('clusterFeatureRules', () => {
  it('saves and loads cluster feature rule presets', () => {
    store.getState().addClusterFeatureRule({
      id: 'short_tf',
      name: 'Short TF',
      enabled: true,
      terms: [{ id: 't1', source: 'layer', layer: 'tf', sizeMin: 1, sizeMax: 40 }],
    });

    store.getState().saveClusterFeatureRuleSet('paper rules');
    expect(store.getState().savedClusterFeatureRuleSets).toHaveLength(1);

    store.getState().setClusterFeatureRules([]);
    expect(store.getState().clusterFeatureRules).toHaveLength(0);

    store.getState().loadClusterFeatureRuleSet('paper rules');
    expect(store.getState().clusterFeatureRules[0].id).toBe('short_tf');
    expect(store.getState().clusterFeatureRules[0].terms[0].layer).toBe('tf');
  });

  it('removes deleted custom modes from selected peak modes', () => {
    store.setState({
      clusterFeatureRules: [{
        id: 'short_tf',
        name: 'Short TF',
        enabled: true,
        terms: [{ id: 't1', source: 'layer', layer: 'tf', sizeMin: 1, sizeMax: 40 }],
      }],
      clusterPeakMode: 'cluster_rule:short_tf',
      peakModes: { 0: 'cluster_rule:short_tf' },
    });

    store.getState().removeClusterFeatureRule('short_tf');

    expect(store.getState().clusterFeatureRules).toHaveLength(0);
    expect(store.getState().clusterPeakMode).toBe('accessibility');
    expect(store.getState().peakModes[0]).toBeUndefined();
  });

  it('does not store a cluster-rule id as a per-peak layer mode', () => {
    store.setState({
      selectedPeaks: new Set([0]),
      peakModes: { 0: 'tf' },
    });

    store.getState().setClusterPeakMode('cluster_rule:short_tf');

    expect(store.getState().clusterPeakMode).toBe('cluster_rule:short_tf');
    expect(store.getState().peakModes).toEqual({});
  });
});

// ============================================================================
// analysisSortRules
// ============================================================================

describe('analysisSortRules', () => {
  it('saves and loads analysis sort rule presets', () => {
    store.getState().addAnalysisSortRule({
      id: 'tf_count',
      name: 'TF count',
      enabled: true,
      scope: { kind: 'selectedPeaks' },
      terms: [{ id: 't1', source: 'layer', layer: 'tf', sizeMin: 20, sizeMax: 80 }],
      metric: 'count',
      descending: true,
    });

    store.getState().saveAnalysisSortRuleSet('sort rules');
    expect(store.getState().savedAnalysisSortRuleSets).toHaveLength(1);

    store.getState().setAnalysisSortRules([]);
    expect(store.getState().analysisSortRules).toHaveLength(0);

    store.getState().loadAnalysisSortRuleSet('sort rules');
    expect(store.getState().analysisSortRules[0].id).toBe('tf_count');
    expect(store.getState().analysisSortRules[0].terms[0].layer).toBe('tf');
    expect(store.getState().analysisSortRules[0].metric).toBe('count');
  });
});

// ============================================================================
// analysisFilterRules
// ============================================================================

describe('analysisFilterRules', () => {
  it('saves and loads analysis filter rule presets', () => {
    store.getState().addAnalysisFilterRule({
      id: 'fire_count',
      name: 'FIRE count',
      enabled: true,
      scope: { kind: 'selectedPeaks' },
      terms: [{ id: 't1', source: 'layer', layer: 'fire', sizeMin: 40, sizeMax: null }],
      metric: 'count',
      operator: 'gte',
      threshold: 1,
    });

    store.getState().saveAnalysisFilterRuleSet('filter rules');
    expect(store.getState().savedAnalysisFilterRuleSets).toHaveLength(1);

    store.getState().setAnalysisFilterRules([]);
    expect(store.getState().analysisFilterRules).toHaveLength(0);

    store.getState().loadAnalysisFilterRuleSet('filter rules');
    expect(store.getState().analysisFilterRules[0].id).toBe('fire_count');
    expect(store.getState().analysisFilterRules[0].terms[0].layer).toBe('fire');
    expect(store.getState().analysisFilterRules[0].operator).toBe('gte');
    expect(store.getState().analysisFilterRules[0].threshold).toBe(1);
  });
});

// ============================================================================
// deleteSelectedPeaks
// ============================================================================

describe('deleteSelectedPeaks', () => {
  it('deletes custom peaks', () => {
    store.setState({
      peaksByRule: { ...store.getState().peaksByRule, 'default-custom': [
        { start: 100, end: 200, index: 10000, layer: 0 },
        { start: 300, end: 400, index: 10001, layer: 0 },
      ] },
      selectedPeaks: new Set([10000]),
    });
    store.getState().deleteSelectedPeaks();
    const customPeaks = store.getState().peaksByRule['default-custom'] || [];
    expect(customPeaks).toHaveLength(1);
    expect(customPeaks[0].start).toBe(300);
  });

  it('re-indexes remaining custom peaks', () => {
    store.setState({
      peaksByRule: { ...store.getState().peaksByRule, 'default-custom': [
        { start: 100, end: 200, index: 10000, layer: 0 },
        { start: 300, end: 400, index: 10001, layer: 0 },
        { start: 500, end: 600, index: 10002, layer: 0 },
      ] },
      selectedPeaks: new Set([10000, 10002]),
    });
    store.getState().deleteSelectedPeaks();
    const customPeaks = store.getState().peaksByRule['default-custom'] || [];
    expect(customPeaks).toHaveLength(1);
    // Remaining peak should be re-indexed to 10000 (custom rule offset)
    expect(customPeaks[0].index).toBe(10000);
  });

  it('clears selection after delete', () => {
    store.setState({
      peaksByRule: { ...store.getState().peaksByRule, 'default-custom': [
        { start: 100, end: 200, index: 10000, layer: 0 },
      ] },
      selectedPeaks: new Set([10000]),
    });
    store.getState().deleteSelectedPeaks();
    expect(store.getState().selectedPeaks.size).toBe(0);
  });

  it('clears stale per-peak modes when deleting and reindexing peaks', () => {
    store.setState({
      peaksByRule: { ...store.getState().peaksByRule, 'default-custom': [
        { start: 100, end: 200, index: 10000, layer: 0 },
        { start: 300, end: 400, index: 10001, layer: 0 },
      ] },
      selectedPeaks: new Set([10000]),
      peakModes: { 10000: 'tf', 10001: 'nuc' },
    });

    store.getState().deleteSelectedPeaks();

    expect(store.getState().peakModes).toEqual({});
  });
});

// ============================================================================
// setClusterAssignments — auto-initializes order
// ============================================================================

describe('setClusterAssignments', () => {
  it('auto-initializes clusterOrder', () => {
    store.getState().setClusterAssignments('ds1', { r1: 0, r2: 1, r3: 2 });
    const order = store.getState().clusterOrder['ds1'];
    expect(order).toEqual([0, 1, 2]);
  });

  it('preserves existing order for matching cluster ids', () => {
    store.getState().setClusterOrder('ds1', [2, 0, 1]); // custom order
    store.getState().setClusterAssignments('ds1', { r1: 0, r2: 1, r3: 2 });
    expect(store.getState().clusterOrder['ds1']).toEqual([2, 0, 1]);
  });

  it('appends new clusters and removes stale clusters from an existing order', () => {
    store.getState().setClusterOrder('ds1', [0, 1]); // 2 clusters
    store.getState().setClusterAssignments('ds1', { r1: 0, r2: 1, r3: 2 }); // 3 clusters
    expect(store.getState().clusterOrder['ds1']).toEqual([0, 1, 2]);

    store.getState().setClusterAssignments('ds1', { r1: 0, r2: -1, r3: -1 });
    expect(store.getState().clusterOrder['ds1']).toEqual([0, -1]);
  });
});

// ============================================================================
// resetClusterState
// ============================================================================

describe('resetClusterState', () => {
  it('clears flat clustering and branch state', () => {
    store.setState({
      clusterAssignments: { ds1: { r1: 0, r2: -1 } },
      clusterOrder: { ds1: [0, -1] },
      selectedClusters: { ds1: new Set([0]) },
      clusterPatterns: { 0: [1] },
      clusterPeakRegions: [{ start: 100, end: 200 }],
      dynamicClustering: true,
      readSortOrder: { ds1: ['r1', 'r2'] },
      clusterFocus: { ds1: new Set([0]) },
      clusterTreeNodes: {
        node1: {
          id: 'node1',
          parentId: null,
          name: 'All reads',
          createdAt: 1,
          chrom: 'chr2L',
          start: 100,
          end: 200,
          sourceClusterIds: [],
          clusterMethod: 'kmeans',
          clusterK: 2,
          subnucleosomalThreshold: 90,
          accessibilityThreshold: 0.5,
          peakRegions: [],
          selectedPeakIndices: [],
          peakModes: {},
          patterns: {},
          dynamicClustering: true,
          assignments: { ds1: { r1: 0 } },
          order: { ds1: [0] },
          focus: {},
        },
      },
      clusterTreeRootIds: ['node1'],
      activeClusterTreeNodeId: 'node1',
      clusterProfiles: { ds1: { 0: { nuc: [1, 2] } } },
    });

    store.getState().resetClusterState();

    expect(store.getState().clusterAssignments).toEqual({});
    expect(store.getState().clusterOrder).toEqual({});
    expect(store.getState().selectedClusters).toEqual({});
    expect(store.getState().clusterPatterns).toEqual({});
    expect(store.getState().clusterPeakRegions).toEqual([]);
    expect(store.getState().dynamicClustering).toBe(false);
    expect(store.getState().readSortOrder).toEqual({});
    expect(store.getState().clusterFocus).toEqual({});
    expect(store.getState().clusterTreeNodes).toEqual({});
    expect(store.getState().clusterTreeRootIds).toEqual([]);
    expect(store.getState().activeClusterTreeNodeId).toBeNull();
    expect(store.getState().clusterProfiles).toEqual({});
  });

  it('keeps TF as the visible and effective mode after clear and reselection', () => {
    store.getState().togglePeakSelection(0);
    store.getState().setClusterPeakMode('tf');
    store.setState({ clusterAssignments: { ds1: { r1: 0 } } });

    store.getState().resetClusterState();
    store.getState().togglePeakSelection(0); // deselect the original peak
    store.getState().togglePeakSelection(0, 'accessibility'); // reselect it through FireTrack's legacy fallback
    store.getState().togglePeakSelection(1, 'accessibility'); // add another peak

    const state = store.getState();
    expect(state.clusterPeakMode).toBe('tf');
    expect(state.peakModes[0]).toBe('tf');
    expect(state.peakModes[1]).toBe('tf');
  });
});

// ============================================================================
// Manual cluster selection/merge
// ============================================================================

describe('manual cluster merge', () => {
  it('sets selected clusters per state key', () => {
    store.getState().setClusterSelection('ds1', [2, 4]);
    expect([...store.getState().selectedClusters.ds1].sort((a, b) => a - b)).toEqual([2, 4]);

    store.getState().setClusterSelection('ds1', [3]);
    expect([...store.getState().selectedClusters.ds1]).toEqual([3]);

    store.getState().setClusterSelection('ds1', []);
    expect(store.getState().selectedClusters.ds1).toBeUndefined();
  });

  it('toggles selected clusters per state key', () => {
    store.getState().toggleClusterSelection('ds1', 2);
    store.getState().toggleClusterSelection('ds1', 4);
    expect([...store.getState().selectedClusters.ds1].sort((a, b) => a - b)).toEqual([2, 4]);

    store.getState().toggleClusterSelection('ds1', 2);
    expect([...store.getState().selectedClusters.ds1]).toEqual([4]);
  });

  it('merges selected clusters into the first selected cluster in the current order', () => {
    store.setState({
      clusterAssignments: { ds1: { r1: 0, r2: 1, r3: 2, r4: 2 } },
      clusterOrder: { ds1: [2, 0, 1] },
      clusterFocus: { ds1: new Set([1]) },
    });
    store.getState().toggleClusterSelection('ds1', 1);
    store.getState().toggleClusterSelection('ds1', 2);

    const changed = store.getState().mergeSelectedClusters(['ds1']);

    expect(changed).toBe(1);
    expect(store.getState().clusterAssignments.ds1).toEqual({ r1: 0, r2: 2, r3: 2, r4: 2 });
    expect(store.getState().clusterOrder.ds1).toEqual([2, 0]);
    expect(store.getState().clusterFocus.ds1).toBeNull();
    expect(store.getState().selectedClusters).toEqual({});
  });

  it('does not use the unassigned bucket as the merge target when a fitted cluster is selected', () => {
    store.setState({
      clusterAssignments: { ds1: { r1: -1, r2: 1, r3: 1, r4: 2 } },
      clusterOrder: { ds1: [-1, 1, 2] },
    });
    store.getState().setClusterSelection('ds1', [-1, 1]);

    const changed = store.getState().mergeSelectedClusters(['ds1']);

    expect(changed).toBe(1);
    expect(store.getState().clusterAssignments.ds1).toEqual({ r1: 1, r2: 1, r3: 1, r4: 2 });
    expect(store.getState().clusterOrder.ds1).toEqual([1, 2]);
  });
});

// ============================================================================
// Cluster tree
// ============================================================================

describe('cluster tree branches', () => {
  it('captures and reapplies the active clustering as a tree node', () => {
    store.setState({
      chrom: 'chr2L',
      start: 100,
      end: 500,
      clusterAssignments: { ds1: { r1: 0, r2: 1 } },
      clusterOrder: { ds1: [1, 0] },
      clusterFocus: { ds1: new Set([1]) },
      clusterPatterns: { 0: [1], 1: [0] },
      clusterPeakRegions: [{ start: 120, end: 180, mode: 'accessibility' }],
      dynamicClustering: true,
    });

    const nodeId = store.getState().captureActiveClusterTreeNode({ name: 'Root run' });
    expect(nodeId).toBeTruthy();

    store.setState({
      clusterAssignments: { ds1: { r3: 2 } },
      clusterOrder: { ds1: [2] },
      clusterFocus: {},
      clusterPatterns: {},
      clusterPeakRegions: [],
      dynamicClustering: false,
    });

    store.getState().applyClusterTreeNode(nodeId!);

    expect(store.getState().activeClusterTreeNodeId).toBe(nodeId);
    expect(store.getState().clusterAssignments.ds1).toEqual({ r1: 0, r2: 1 });
    expect(store.getState().clusterOrder.ds1).toEqual([1, 0]);
    expect(store.getState().clusterFocus.ds1).toEqual(new Set([1]));
    expect(store.getState().clusterPatterns).toEqual({ 0: [1], 1: [0] });
    expect(store.getState().dynamicClustering).toBe(true);
  });

  it('creates a child branch and can delete it back to the parent', () => {
    store.setState({
      clusterAssignments: { ds1: { r1: 0, r2: 0, r3: 1 } },
      clusterOrder: { ds1: [0, 1] },
      clusterFocus: { ds1: new Set([0]) },
    });
    const parentId = store.getState().captureActiveClusterTreeNode({ name: 'All reads' });

    store.setState({
      clusterAssignments: { ds1: { r1: 10, r2: 11 } },
      clusterOrder: { ds1: [10, 11] },
      clusterFocus: {},
    });
    const childId = store.getState().createClusterTreeChildFromActive(parentId!, {
      sourceClusterIds: [0],
      sourceLabel: 'from C0',
      readScope: { ds1: ['r1', 'r2'] },
    });

    expect(childId).toBeTruthy();
    expect(store.getState().activeClusterTreeNodeId).toBe(childId);
    expect(store.getState().clusterTreeNodes[childId!].parentId).toBe(parentId);
    expect(store.getState().clusterTreeNodes[childId!].sourceClusterIds).toEqual([0]);
    expect(store.getState().clusterTreeNodes[childId!].readScope).toEqual({ ds1: ['r1', 'r2'] });

    store.getState().applyClusterTreeNode(parentId!);
    expect(store.getState().clusterAssignments.ds1).toEqual({ r1: 0, r2: 0, r3: 1 });

    store.getState().applyClusterTreeNode(childId!);
    expect(store.getState().clusterAssignments.ds1).toEqual({ r1: 10, r2: 11 });

    store.getState().deleteClusterTreeNode(childId!);
    expect(store.getState().activeClusterTreeNodeId).toBe(parentId);
    expect(store.getState().clusterTreeNodes[childId!]).toBeUndefined();
    expect(store.getState().clusterAssignments.ds1).toEqual({ r1: 0, r2: 0, r3: 1 });
  });

  it('keeps the active branch snapshot synced with assignment and focus edits', () => {
    store.setState({
      clusterAssignments: { ds1: { r1: 0, r2: 1 } },
      clusterOrder: { ds1: [0, 1] },
    });
    const nodeId = store.getState().captureActiveClusterTreeNode({ name: 'Active run' });

    store.getState().setClusterAssignments('ds1', { r1: 2, r2: 2, r3: 3 });
    store.getState().setClusterOrder('ds1', [2, 3]);
    store.getState().setClusterFocus('ds1', new Set([2]));

    const node = store.getState().clusterTreeNodes[nodeId!];
    expect(node.assignments.ds1).toEqual({ r1: 2, r2: 2, r3: 3 });
    expect(node.order.ds1).toEqual([2, 3]);
    expect(node.focus.ds1).toEqual([2]);
  });

  it('does not mutate the active branch snapshot on a non-mirroring (navigation) pass', () => {
    store.setState({
      clusterAssignments: { ds1: { r1: 0, r2: 0, r3: 1 } },
      clusterOrder: { ds1: [0, 1] },
    });
    const nodeId = store.getState().captureActiveClusterTreeNode({ name: 'All reads' });

    // Reproduce a tab whose live projection was already contracted by an old
    // build before this safeguard ran. The immutable node is still complete.
    store.setState({ clusterAssignments: { ds1: { r1: 0 } } });

    // Simulate a partial dynamic/navigation reassignment at a different
    // viewport: live state self-heals from the snapshot and merges new labels,
    // while the saved snapshot stays pristine.
    store.getState().setClusterAssignments(
      'ds1',
      { r1: 1, r4: -1 },
      { mirror: false, merge: true },
    );
    store.getState().setClusterOrder('ds1', [1, -1], { mirror: false });

    const node = store.getState().clusterTreeNodes[nodeId!];
    expect(store.getState().clusterAssignments.ds1).toEqual({ r1: 1, r2: 0, r3: 1, r4: -1 });
    expect(node.assignments.ds1).toEqual({ r1: 0, r2: 0, r3: 1 });
    expect(node.order.ds1).toEqual([0, 1]);

    // Returning up the tree restores the pristine snapshot, not the reshuffle.
    store.getState().applyClusterTreeNode(nodeId!);
    expect(store.getState().clusterAssignments.ds1).toEqual({ r1: 0, r2: 0, r3: 1 });
    expect(store.getState().clusterOrder.ds1).toEqual([0, 1]);
  });

  it('repairs a large clustered cohort before merging a tiny dynamic response', () => {
    const saved = Object.fromEntries(
      Array.from({ length: 2_500 }, (_, index) => [`movie/${index}/ccs`, index % 4]),
    );
    store.setState({ clusterAssignments: { ds1: saved } });
    const nodeId = store.getState().captureActiveClusterTreeNode({ name: 'Large cohort' });

    // This is the failure shape seen after a payload-changing layer refetch:
    // an old browser had already replaced the live 2,500-read map with three.
    store.setState({
      clusterAssignments: {
        ds1: { 'movie/7/ccs': 3, 'movie/19/ccs': 2, 'new-read': 1 },
      },
    });
    store.getState().setClusterAssignments(
      'ds1',
      { 'movie/7/ccs': 1, 'new-read': 2 },
      { mirror: false, merge: true },
    );

    const live = store.getState().clusterAssignments.ds1;
    expect(Object.keys(live)).toHaveLength(2_501);
    expect(live['movie/0/ccs']).toBe(0);
    expect(live['movie/7/ccs']).toBe(1);
    expect(live['new-read']).toBe(2);
    expect(Object.keys(store.getState().clusterTreeNodes[nodeId!].assignments.ds1)).toHaveLength(2_500);
  });

  it('restores peak selection and modes when switching cluster branches', () => {
    const ruleId = store.getState().peakRules[0].id;
    store.getState().setPeaksByRule(ruleId, [
      { start: 100, end: 150, index: 0, layer: 0 },
      { start: 200, end: 260, index: 1, layer: 0 },
    ]);
    const [firstPeak, secondPeak] = store.getState().getAllPeaks();
    store.setState({
      selectedPeaks: new Set([firstPeak.index]),
      peakModes: { [firstPeak.index]: 'tf' },
      clusterPeakRegions: [{ start: secondPeak.start, end: secondPeak.end, mode: 'fire' }],
      clusterAssignments: { ds1: { r1: 0, r2: 1 } },
      clusterOrder: { ds1: [0, 1] },
    });

    const nodeId = store.getState().captureActiveClusterTreeNode({ name: 'Peak run' });
    store.setState({ selectedPeaks: new Set(), peakModes: {}, clusterPeakRegions: [] });

    store.getState().applyClusterTreeNode(nodeId!);

    expect([...store.getState().selectedPeaks].sort((a, b) => a - b)).toEqual([
      firstPeak.index,
      secondPeak.index,
    ].sort((a, b) => a - b));
    expect(store.getState().peakModes[firstPeak.index]).toBe('tf');
    expect(store.getState().peakModes[secondPeak.index]).toBe('fire');
  });

  it('renames a cluster branch without changing its assignments', () => {
    store.setState({
      clusterAssignments: { ds1: { r1: 0, r2: 1 } },
      clusterOrder: { ds1: [0, 1] },
    });
    const nodeId = store.getState().captureActiveClusterTreeNode({ name: 'All reads' });

    store.getState().renameClusterTreeNode(nodeId!, 'Favorite branch');

    expect(store.getState().clusterTreeNodes[nodeId!].name).toBe('Favorite branch');
    expect(store.getState().clusterTreeNodes[nodeId!].assignments.ds1).toEqual({ r1: 0, r2: 1 });
  });
});

// ============================================================================
// Custom peak drawing
// ============================================================================

describe('custom peak drawing', () => {
  it('addCustomPeak creates peak in custom rule peaksByRule', () => {
    store.getState().addCustomPeak(100, 200);
    const customPeaks = store.getState().peaksByRule['default-custom'] || [];
    expect(customPeaks).toHaveLength(1);
    expect(customPeaks[0].index).toBe(10000);
    expect(customPeaks[0].isCustom).toBe(true);
  });

  it('addCustomPeak normalizes start/end order', () => {
    store.getState().addCustomPeak(500, 100); // reversed
    const customPeaks = store.getState().peaksByRule['default-custom'] || [];
    expect(customPeaks[0].start).toBe(100);
    expect(customPeaks[0].end).toBe(500);
  });

  it('clearCustomPeaks removes only custom peaks from selection', () => {
    store.getState().addCustomPeak(100, 200);
    store.setState({
      selectedPeaks: new Set([0, 1, 10000]), // mix of accessibility and custom
    });
    store.getState().clearCustomPeaks();
    const customPeaks = store.getState().peaksByRule['default-custom'] || [];
    expect(customPeaks).toHaveLength(0);
    // Accessibility peak indices (< 10000) should remain
    expect(store.getState().selectedPeaks.has(0)).toBe(true);
    expect(store.getState().selectedPeaks.has(1)).toBe(true);
    expect(store.getState().selectedPeaks.has(10000)).toBe(false);
  });
});

// ============================================================================
// Gene selection and transcription state
// ============================================================================

describe('gene selection', () => {
  const gene1 = { id: 'g1', name: 'TP53', chrom: 'chr17', start: 100, end: 500, strand: '+', biotype: 'protein_coding', exons: [] };
  const gene2 = { id: 'g2', name: 'BRCA1', chrom: 'chr17', start: 600, end: 1000, strand: '-', biotype: 'protein_coding', exons: [] };

  it('toggleGeneSelection adds a gene', () => {
    store.getState().toggleGeneSelection(gene1);
    expect(store.getState().selectedGenes).toHaveLength(1);
    expect(store.getState().selectedGenes[0].id).toBe('g1');
  });

  it('toggleGeneSelection removes already-selected gene', () => {
    store.getState().toggleGeneSelection(gene1);
    store.getState().toggleGeneSelection(gene1);
    expect(store.getState().selectedGenes).toHaveLength(0);
  });

  it('setSelectedGenes replaces gene list', () => {
    store.getState().setSelectedGenes([gene1, gene2]);
    expect(store.getState().selectedGenes).toHaveLength(2);
  });
});

describe('transcription state filters', () => {
  it('setTranscriptionStateFilters updates partial filters', () => {
    store.getState().setTranscriptionStateFilters({ pause: true });
    expect(store.getState().transcriptionStateFilters.pause).toBe(true);
    expect(store.getState().transcriptionStateFilters.pic).toBe(false);
  });

  it('resetTranscriptionStateFilters clears all', () => {
    store.getState().setTranscriptionStateFilters({ pause: true, pic: true });
    store.getState().resetTranscriptionStateFilters();
    expect(store.getState().transcriptionStateFilters.pause).toBe(false);
    expect(store.getState().transcriptionStateFilters.pic).toBe(false);
  });
});

// ============================================================================
// Cluster focus
// ============================================================================

describe('cluster focus', () => {
  it('setClusterFocus sets focused clusters', () => {
    store.getState().setClusterFocus('ds1', new Set([0, 2]));
    expect(store.getState().clusterFocus['ds1']?.has(0)).toBe(true);
    expect(store.getState().clusterFocus['ds1']?.has(1)).toBe(false);
  });

  it('clearClusterFocus clears all', () => {
    store.getState().setClusterFocus('ds1', new Set([0]));
    store.getState().clearClusterFocus();
    expect(store.getState().clusterFocus).toEqual({});
  });
});

// ============================================================================
// Read filter provenance
// ============================================================================

describe('read filter provenance', () => {
  it('stores the source for active read filters', () => {
    const source = { target: 'annotation-filter' as const, label: 'Annotations > Filter' };
    store.getState().setFilteredReadIds('ds1', new Set(['r1', 'r2']), source);

    expect(store.getState().filteredReadIds.ds1?.has('r1')).toBe(true);
    expect(store.getState().readFilterSources.ds1).toEqual(source);
  });

  it('preserves existing source when refreshing ids without a new source', () => {
    const source = { target: 'transcription-filters' as const, label: 'Transcription State > Filters' };
    store.getState().setFilteredReadIds('ds1', new Set(['r1']), source);
    store.getState().setFilteredReadIds('ds1', new Set(['r2']));

    expect(store.getState().filteredReadIds.ds1?.has('r2')).toBe(true);
    expect(store.getState().readFilterSources.ds1).toEqual(source);
  });

  it('clears source when filters are cleared', () => {
    store.getState().setFilteredReadIds('ds1', new Set(['r1']), {
      target: 'footprint-cooccurrence',
      label: 'Footprint Analysis > Co-occ',
    });
    store.getState().setFilteredReadIds('ds1', null);

    expect(store.getState().filteredReadIds.ds1).toBeNull();
    expect(store.getState().readFilterSources.ds1).toBeNull();
  });

  it('clearAllFilters resets all read filter sources', () => {
    store.getState().setFilteredReadIds('ds1', new Set(['r1']), {
      target: 'annotation-filter',
      label: 'Annotations > Filter',
    });
    store.getState().clearAllFilters();

    expect(store.getState().filteredReadIds).toEqual({});
    expect(store.getState().readFilterSources).toEqual({});
  });
});

// ============================================================================
// selectPeaksByLayer
// ============================================================================

describe('selectPeaksByLayer', () => {
  it('selects all peaks in a layer', () => {
    store.setState({
      peaksByRule: { ...store.getState().peaksByRule, 'default-accessibility': [
        { start: 100, end: 200, index: 0, layer: 0 },
        { start: 300, end: 400, index: 1, layer: 0 },
        { start: 500, end: 600, index: 2, layer: 1 },
      ] },
    });
    store.getState().selectPeaksByLayer(0);
    expect(store.getState().selectedPeaks.has(0)).toBe(true);
    expect(store.getState().selectedPeaks.has(1)).toBe(true);
    expect(store.getState().selectedPeaks.has(2)).toBe(false);
  });

  it('deselects all if all in layer are already selected', () => {
    store.setState({
      peaksByRule: { ...store.getState().peaksByRule, 'default-accessibility': [
        { start: 100, end: 200, index: 0, layer: 0 },
        { start: 300, end: 400, index: 1, layer: 0 },
      ] },
      selectedPeaks: new Set([0, 1]),
    });
    store.getState().selectPeaksByLayer(0);
    expect(store.getState().selectedPeaks.has(0)).toBe(false);
    expect(store.getState().selectedPeaks.has(1)).toBe(false);
  });

  it('assigns the visible cluster mode to every newly selected peak', () => {
    store.setState({
      clusterPeakMode: 'tf',
      peaksByRule: { ...store.getState().peaksByRule, 'default-accessibility': [
        { start: 100, end: 200, index: 0, layer: 0 },
        { start: 300, end: 400, index: 1, layer: 0 },
      ] },
    });

    store.getState().selectPeaksByLayer(0);

    expect(store.getState().peakModes[0]).toBe('tf');
    expect(store.getState().peakModes[1]).toBe('tf');
  });

  it('removes per-peak modes when bulk deselecting a layer', () => {
    store.setState({
      clusterPeakMode: 'tf',
      selectedPeaks: new Set([0, 1]),
      peakModes: { 0: 'tf', 1: 'tf' },
      peaksByRule: { ...store.getState().peaksByRule, 'default-accessibility': [
        { start: 100, end: 200, index: 0, layer: 0 },
        { start: 300, end: 400, index: 1, layer: 0 },
      ] },
    });

    store.getState().selectPeaksByLayer(0);

    expect(store.getState().selectedPeaks.size).toBe(0);
    expect(store.getState().peakModes).toEqual({});
  });
});
