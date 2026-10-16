/**
 * Multi-step store workflow tests.
 *
 * These verify that Zustand slices compose correctly for realistic
 * user journeys — panel lifecycle, navigation state clearing,
 * history undo/redo, and cross-slice interactions.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestStore, ensureBuiltinPanelsRegistered } from './helpers';
import { serializeState } from '../historySlice';

let store: ReturnType<typeof createTestStore>;

beforeEach(() => {
  localStorage.clear();
  ensureBuiltinPanelsRegistered();
  store = createTestStore();
});

// ============================================================================
// Panel lifecycle workflow
// ============================================================================

describe('panel lifecycle workflow', () => {
  it('addPanel → openAnalysisPanel (singleton) → open again (no dup) → collapse → restore → close', () => {
    // Step 1: Add a dataset panel
    const dsId = store.getState().addPanel('ds1');
    expect(store.getState().panels).toHaveLength(1);

    // Step 2: Open an analysis panel
    store.getState().openAnalysisPanel('cluster-detail');
    expect(store.getState().panels).toHaveLength(2);
    const analysisPanelId = store.getState().panels.find(
      p => p.contentType === 'cluster-detail'
    )!.id;

    // Step 3: Try opening same analysis panel again — singleton, no dup
    store.getState().openAnalysisPanel('cluster-detail');
    expect(store.getState().panels).toHaveLength(2);

    // Step 4: Collapse the analysis panel
    store.getState().setPanelCollapsed(analysisPanelId, true);
    expect(
      store.getState().panels.find(p => p.id === analysisPanelId)!.collapsed
    ).toBe(true);

    // Step 5: Restore (uncollapse) it
    store.getState().setPanelCollapsed(analysisPanelId, false);
    expect(
      store.getState().panels.find(p => p.id === analysisPanelId)!.collapsed
    ).toBe(false);

    // Step 6: Close the analysis panel
    store.getState().closeAnalysisPanel(analysisPanelId);
    expect(store.getState().panels).toHaveLength(1);
    expect(store.getState().panels[0].id).toBe(dsId);
  });
});

// ============================================================================
// Colormap workflow
// ============================================================================

describe('colormap workflow', () => {
  it('migrates legacy colormaps through the public setter', () => {
    store.getState().setActiveColormap({
      name: 'Notebook labels',
      rules: [{
        id: 'legacy-rule',
        name: 'Legacy rule',
        color: '#22c55e',
        sizeMin: 1,
        sizeMax: null,
        enabled: true,
      }],
    } as any);

    const active = store.getState().activeColormap;
    expect(active.name).toBe('Notebook labels');
    expect(active.backgroundColor).toBe('#ffffff');
    expect(active.readBackgroundColor).toBe('#f1f5f9');
    expect(active.noReadBackgroundColor).toBe('#ffffff');
    expect(active.qualityShading).toBeDefined();
    expect(active.tfOverlay).toBeDefined();
    expect(active.displaySmoothing).toEqual({ enabled: false, sigmaX: 0, sigmaY: 0 });
    expect(active.qualityFilters).toEqual(expect.arrayContaining([
      expect.objectContaining({ layer: 'fire', qualityName: 'aq', minValue: 230, enabled: true }),
    ]));
    expect(active.rules[0]).toMatchObject({
      opacity: 1,
      targetLayers: [],
      conditions: [],
      qualityGates: [],
    });
  });
});

// ============================================================================
// Dataset + panel + stateKey interaction
// ============================================================================

describe('dataset + panel + stateKey interaction', () => {
  it('addPanel for 2 datasets → duplicatePanel → verify stateKey + independent state', () => {
    // Step 1: Add panels for two datasets
    const p1 = store.getState().addPanel('ds1');
    const p2 = store.getState().addPanel('ds2');
    expect(store.getState().panels).toHaveLength(2);

    // Step 2: Duplicate first panel
    const clone = store.getState().duplicatePanel(p1);
    expect(clone).toBeTruthy();
    expect(store.getState().panels).toHaveLength(3);

    // Step 3: Clone should have independent stateKey
    const clonePanel = store.getState().panels.find(p => p.id === clone)!;
    expect(clonePanel.datasetId).toBe('ds1');
    expect(clonePanel.stateKey).toBeTruthy();
    // stateKey should differ from the original panel's stateKey
    const origPanel = store.getState().panels.find(p => p.id === p1)!;
    // After duplication, both should have stateKeys that differ from each other
    if (origPanel.stateKey && clonePanel.stateKey) {
      expect(origPanel.stateKey).not.toBe(clonePanel.stateKey);
    }

    // Step 4: Clone should be unlinked
    expect(clonePanel.linkGroup).toBeNull();

    // Step 5: Set cluster assignments for each stateKey — they should be independent
    const origKey = origPanel.stateKey || origPanel.datasetId!;
    const cloneKey = clonePanel.stateKey!;

    store.setState({
      clusterAssignments: {
        [origKey]: { read1: 0, read2: 1 },
        [cloneKey]: { read1: 1, read2: 0 },
      },
    });

    const assignments = store.getState().clusterAssignments;
    expect(assignments[origKey]).toEqual({ read1: 0, read2: 1 });
    expect(assignments[cloneKey]).toEqual({ read1: 1, read2: 0 });
  });
});

// ============================================================================
// Navigation clears transient state
// ============================================================================

describe('navigation clears transient state', () => {
  it('setViewport to different chromosome clears selectedPeaks, clusterAssignments, selectedGenes', () => {
    // Step 1: Set up some state
    store.setState({
      chrom: 'chr1',
      start: 1000,
      end: 2000,
      selectedPeaks: new Set([0, 1, 2]),
      clusterAssignments: { ds1: { read1: 0 } },
      selectedGenes: [{ id: 'gene1', name: 'test', start: 1000, end: 2000, strand: '+', exons: [], chrom: 'chr1', biotype: 'protein_coding' }],
    });

    // Step 2: Navigate to a different chromosome
    store.getState().setViewport('chr2', 5000, 6000);

    // Step 3: Verify everything was cleared
    const state = store.getState();
    expect(state.chrom).toBe('chr2');
    expect(state.start).toBe(5000);
    expect(state.end).toBe(6000);
    expect(state.selectedPeaks.size).toBe(0);
    expect(Object.keys(state.clusterAssignments)).toHaveLength(0);
    expect(state.selectedGenes).toHaveLength(0);
  });

  it('setViewport on same chromosome clears peaks when no peaks visible', () => {
    // Set up state with peaks that will be out of range
    store.setState({
      chrom: 'chr1',
      start: 1000,
      end: 2000,
      selectedPeaks: new Set([0]),
      peaksByRule: {},
    });

    // Navigate far away on same chromosome (no peaks to preserve)
    store.getState().setViewport('chr1', 500000, 510000);

    const state = store.getState();
    expect(state.selectedPeaks.size).toBe(0);
  });
});

// ============================================================================
// History undo/redo workflow
// ============================================================================

describe('history undo/redo workflow', () => {
  it('serializes newer session fields used by restore and undo', () => {
    const catalog = [{
      id: 'cat-tf',
      source: 'local',
      kind: 'bigbed',
      label: 'TF motifs',
      path: '/tmp/tf.bigBed',
      loaded: true,
      filterNames: ['Zld'],
    }];
    const compositeTracks = [{
      id: 'comp-meta',
      label: 'Default metaprofile',
      kind: 'metaprofile',
      sources: [{
        id: 'src-nuc',
        ref: { kind: 'metaprofile', ruleId: 'nuc' },
        color: '#2563eb',
        visible: true,
        negate: false,
        scale: 1,
      }],
      scaleMode: 'auto',
      logScale: false,
      visible: true,
      groupAutoscaleSelected: false,
      showAxes: true,
    }];
    const savedTracks = [{
      id: 'saved-meta',
      name: 'Pinned metaprofile',
      savedAt: '2026-04-30T00:00:00.000Z',
      composite: {
        label: 'Pinned metaprofile',
        kind: 'metaprofile',
        sources: [],
        scaleMode: 'auto',
        logScale: false,
        visible: true,
        groupAutoscaleSelected: false,
        showAxes: true,
      },
    }];

    store.setState({
      clickTargetLayer: 'tf',
      footprintAnalysisLayer: 'nuc',
      readScrollOffsets: { ds1: 128 },
      showGenomeOverview: false,
      publicMode: true,
      catalog: catalog as any,
      compositeTracks: compositeTracks as any,
      savedTracks: savedTracks as any,
    });

    const serialized = serializeState(store.getState());

    expect(serialized.clickTargetLayer).toBe('tf');
    expect(serialized.footprintAnalysisLayer).toBe('nuc');
    expect(serialized.readScrollOffsets).toEqual({ ds1: 128 });
    expect(serialized.showGenomeOverview).toBe(false);
    expect(serialized.publicMode).toBe(true);
    expect('interactionMode' in serialized).toBe(false); // click modes removed (fb-r4-clicks)
    expect(serialized.catalog).toEqual(catalog);
    expect(serialized.compositeTracks).toEqual(compositeTracks);
    expect(serialized.savedTracks).toEqual(savedTracks);
  });

  it('undo/redo restores newer UI, interaction, and track-cart fields', () => {
    const initialCatalog = [{
      id: 'cat-a',
      source: 'local',
      kind: 'bigbed',
      label: 'TF A',
      path: '/tmp/a.bb',
      loaded: true,
    }];
    const initialCompositeTracks = [{
      id: 'comp-a',
      label: 'A',
      kind: 'annotation',
      sources: [],
      scaleMode: 'auto',
      logScale: false,
      visible: true,
      groupAutoscaleSelected: false,
      showAxes: true,
    }];
    const initialSavedTracks = [{
      id: 'saved-a',
      name: 'A preset',
      savedAt: '2026-04-30T00:00:00.000Z',
      composite: {
        label: 'A preset',
        kind: 'annotation',
        sources: [],
        scaleMode: 'auto',
        logScale: false,
        visible: true,
        groupAutoscaleSelected: false,
        showAxes: true,
      },
    }];
    const changedCatalog = [{
      id: 'cat-b',
      source: 'local',
      kind: 'bigwig',
      label: 'Signal B',
      path: '/tmp/b.bw',
      loaded: true,
    }];
    const changedCompositeTracks = [{
      id: 'comp-b',
      label: 'B',
      kind: 'signal',
      sources: [],
      scaleMode: 'manual',
      yMin: 0,
      yMax: 10,
      logScale: false,
      visible: false,
      groupAutoscaleSelected: false,
      showAxes: false,
    }];
    const changedSavedTracks = [{
      id: 'saved-b',
      name: 'B preset',
      savedAt: '2026-04-30T01:00:00.000Z',
      composite: {
        label: 'B preset',
        kind: 'signal',
        sources: [],
        scaleMode: 'manual',
        logScale: false,
        visible: false,
        groupAutoscaleSelected: false,
        showAxes: false,
      },
    }];

    store.setState({
      clusterK: 3,
      clickTargetLayer: 'tf',
      footprintAnalysisLayer: 'nuc',
      readScrollOffsets: { ds1: 12 },
      showGenomeOverview: false,
      publicMode: true,
      catalog: initialCatalog as any,
      compositeTracks: initialCompositeTracks as any,
      savedTracks: initialSavedTracks as any,
    });
    store.getState().pushSnapshot('Initial UI');

    store.setState({
      clusterK: 5,
      clickTargetLayer: null,
      footprintAnalysisLayer: 'tf',
      readScrollOffsets: { ds1: 64, ds2: 8 },
      showGenomeOverview: true,
      publicMode: false,
      catalog: changedCatalog as any,
      compositeTracks: changedCompositeTracks as any,
      savedTracks: changedSavedTracks as any,
    });
    store.getState().pushSnapshot('Changed UI');

    store.getState().undo();
    expect(store.getState().clusterK).toBe(3);
    expect(store.getState().clickTargetLayer).toBe('tf');
    expect(store.getState().footprintAnalysisLayer).toBe('nuc');
    expect(store.getState().readScrollOffsets).toEqual({}); // Fit restores at the top
    expect(store.getState().showGenomeOverview).toBe(false);
    expect(store.getState().publicMode).toBe(true);
    expect(store.getState().catalog).toEqual(initialCatalog);
    expect(store.getState().compositeTracks).toEqual(initialCompositeTracks);
    expect(store.getState().savedTracks).toEqual(initialSavedTracks);

    store.getState().redo();
    expect(store.getState().clusterK).toBe(5);
    expect(store.getState().clickTargetLayer).toBeNull();
    expect(store.getState().footprintAnalysisLayer).toBe('tf');
    expect(store.getState().readScrollOffsets).toEqual({});
    expect(store.getState().showGenomeOverview).toBe(true);
    expect(store.getState().publicMode).toBe(false);
    expect(store.getState().catalog).toEqual(changedCatalog);
    expect(store.getState().compositeTracks).toEqual(changedCompositeTracks);
    expect(store.getState().savedTracks).toEqual(changedSavedTracks);
  });

  it('migrates legacy colormaps when restoring history snapshots', () => {
    const legacyColormap = {
      name: 'Legacy labels',
      rules: [{
        id: 'legacy-rule',
        name: 'Legacy rule',
        color: '#22c55e',
        sizeMin: 1,
        sizeMax: null,
        enabled: true,
      }],
    };

    store.setState({ clusterK: 3, activeColormap: legacyColormap as any });
    store.getState().pushSnapshot('Legacy labels');

    store.setState({ clusterK: 5, activeColormap: { name: 'Changed', rules: [] } as any });
    store.getState().pushSnapshot('Changed labels');

    store.getState().undo();
    const restored = store.getState().activeColormap;
    expect(restored.name).toBe('Legacy labels');
    expect(restored.qualityShading).toBeDefined();
    expect(restored.tfOverlay).toBeDefined();
    expect(restored.qualityFilters).toEqual(expect.arrayContaining([
      expect.objectContaining({ layer: 'fire', qualityName: 'aq', minValue: 230, enabled: true }),
    ]));
    expect(restored.rules[0]).toMatchObject({
      id: 'legacy-rule',
      targetLayers: [],
      conditions: [],
      qualityGates: [],
    });
  });

  it('normalizes legacy MSP aliases in serialized and restored history snapshots', () => {
    store.setState({
      clusterK: 3,
      enabledModTypes: { msp: true } as any,
      enabledMetaProfiles: { msp: true },
      cachedLayerTypes: { msp: false },
      clickTargetLayer: 'msp',
      footprintAnalysisLayer: 'all',
      activeColormap: {
        name: 'Legacy MSP labels',
        rules: [{
          id: 'msp-rule',
          name: 'MSP rule',
          color: '#f97316',
          sizeMin: 1,
          sizeMax: null,
          targetLayers: ['msp', 'fire'],
          conditions: [],
          enabled: true,
        }],
        qualityFilters: [{ layer: 'msp', qualityName: 'aq', minValue: 230, enabled: true }],
      } as any,
      footprintGroups: [{
        id: 'fg-msp',
        name: 'MSP group',
        color: '#f97316',
        layer: 'msp',
        sizeMin: 1,
        sizeMax: 80,
        overlapFraction: 0,
        enabled: true,
        sourceIndex: -1,
      }] as any,
    });

    const serialized = serializeState(store.getState());
    expect(serialized.enabledModTypes).toEqual({ fire: true });
    expect(serialized.enabledMetaProfiles).toEqual({ fire: true });
    expect(serialized.cachedLayerTypes).toEqual({ fire: false });
    expect(serialized.clickTargetLayer).toBe('fire');
    expect(serialized.footprintAnalysisLayer).toBeNull();
    expect((serialized.activeColormap as any).qualityFilters[0].layer).toBe('fire');
    expect((serialized.activeColormap as any).rules[0].targetLayers).toEqual(['fire']);
    expect((serialized.footprintGroups[0] as any).layer).toBe('fire');

    store.getState().pushSnapshot('Legacy MSP aliases');
    store.setState({
      clusterK: 5,
      enabledModTypes: { tf: true } as any,
      enabledMetaProfiles: { tf: true },
      cachedLayerTypes: { tf: true },
      clickTargetLayer: 'tf',
      footprintAnalysisLayer: 'tf',
      activeColormap: { name: 'Changed', rules: [] } as any,
      footprintGroups: [],
    });
    store.getState().pushSnapshot('Changed aliases');

    store.getState().undo();
    const restored = store.getState();
    expect(restored.enabledModTypes).toEqual({ fire: true });
    expect(restored.enabledMetaProfiles).toEqual({ fire: true });
    expect(restored.cachedLayerTypes).toEqual({ fire: false });
    expect(restored.clickTargetLayer).toBe('fire');
    expect(restored.footprintAnalysisLayer).toBeNull();
    expect(restored.activeColormap.qualityFilters[0].layer).toBe('fire');
    expect(restored.activeColormap.rules[0].targetLayers).toEqual(['fire']);
    expect(restored.footprintGroups[0].layer).toBe('fire');
  });

  it('records cluster focus as undoable history without touching FIRE layer toggles', () => {
    store.setState({
      enabledModTypes: { fire: true, msp: true } as any,
      clusterAssignments: { ds1: { r1: 0, r2: 1 } },
      clusterOrder: { ds1: [0, 1] },
    });

    store.getState().setClusterFocus('ds1', new Set([1]));

    expect(store.getState().enabledModTypes.fire).toBe(true);
    expect(store.getState().enabledModTypes.msp).toBe(true);
    expect(store.getState().clusterFocus.ds1?.has(1)).toBe(true);
    expect(store.getState().canUndo()).toBe(true);

    store.getState().undo();
    expect(store.getState().enabledModTypes.fire).toBe(true);
    expect(store.getState().enabledModTypes.msp).not.toBe(false);
    expect(store.getState().clusterFocus).toEqual({});
  });

  it('records labeling edits as undoable history snapshots', () => {
    store.getState().setReadBackgroundColor('#111827');
    store.getState().setDisplaySmoothing({ enabled: true, sigmaX: 2, sigmaY: 0.5 });

    expect(store.getState().activeColormap.readBackgroundColor).toBe('#111827');
    expect(store.getState().activeColormap.displaySmoothing).toEqual({ enabled: true, sigmaX: 2, sigmaY: 0.5 });
    expect(store.getState().canUndo()).toBe(true);
    expect(store.getState()._historyStack.some(s => s.kind === 'labeling')).toBe(true);

    store.getState().undo();
    expect(store.getState().activeColormap.displaySmoothing).toEqual({ enabled: false, sigmaX: 0, sigmaY: 0 });
    expect(store.getState().activeColormap.readBackgroundColor).toBe('#111827');

    store.getState().undo();
    expect(store.getState().activeColormap.readBackgroundColor).toBe('#f1f5f9');
  });

  it('pushSnapshot → make changes → pushSnapshot → undo → verify → redo → verify', () => {
    // Step 1: Initial state → snapshot "Initial" (with clustering state)
    store.setState({ chrom: 'chr1', start: 1000, end: 2000, clusterK: 3 });
    store.getState().pushSnapshot('Initial');

    // Step 2: Make changes (analysis state, not just viewport)
    store.setState({ chrom: 'chr1', start: 3000, end: 4000, clusterK: 5 });
    store.getState().pushSnapshot('Clustered');

    // Verify we have 2 snapshots
    expect(store.getState()._historyStack).toHaveLength(2);
    expect(store.getState()._historyPointer).toBe(1);

    // Step 3: Undo — should restore the full browser state, including viewport
    store.getState().undo();
    expect(store.getState().clusterK).toBe(3);
    expect(store.getState().start).toBe(1000);
    expect(store.getState().end).toBe(2000);
    expect(store.getState()._historyPointer).toBe(0);

    // Step 4: canUndo/canRedo
    expect(store.getState().canUndo()).toBe(false); // At oldest
    expect(store.getState().canRedo()).toBe(true);

    // Step 5: Redo — should restore the later full browser state
    store.getState().redo();
    expect(store.getState().clusterK).toBe(5);
    expect(store.getState().start).toBe(3000);
    expect(store.getState().end).toBe(4000);
    expect(store.getState()._historyPointer).toBe(1);
    expect(store.getState().canRedo()).toBe(false);
  });

  it('timeline restore can optionally restore the saved viewport', () => {
    store.setState({ chrom: 'chr1', start: 1000, end: 2000, clusterK: 3 });
    store.getState().pushSnapshot('Initial');

    store.setState({ chrom: 'chr2', start: 3000, end: 4000, clusterK: 7 });
    store.getState().pushSnapshot('Moved');

    store.getState().jumpToSnapshot(0);
    expect(store.getState().clusterK).toBe(3);
    expect(store.getState().chrom).toBe('chr2');
    expect(store.getState().start).toBe(3000);

    store.getState().restoreSnapshot(0, { restoreViewport: true });
    expect(store.getState().clusterK).toBe(3);
    expect(store.getState().chrom).toBe('chr1');
    expect(store.getState().start).toBe(1000);
    expect(store.getState().end).toBe(2000);
  });

  it('keeps settled navigation snapshots granular while coalescing sort and filter', () => {
    store.setState({ chrom: 'chr1', start: 1000, end: 2000 });
    store.getState().pushSnapshot('Initial');

    store.setState({ chrom: 'chr1', start: 1100, end: 2100 });
    store.getState().pushSnapshot('Navigate chr1:1.1k-2.1k');
    store.setState({ chrom: 'chr1', start: 1200, end: 2200 });
    store.getState().pushSnapshot('Navigate chr1:1.2k-2.2k');

    expect(store.getState()._historyStack).toHaveLength(3);
    expect(store.getState()._historyStack[1].label).toBe('Navigate chr1:1.1k-2.1k');
    expect(store.getState()._historyStack[1].kind).toBe('navigation');
    expect(store.getState()._historyStack[2].label).toBe('Navigate chr1:1.2k-2.2k');
    expect(store.getState()._historyStack[2].kind).toBe('navigation');

    store.getState().pushSnapshot('Sort by name');
    store.getState().pushSnapshot('Sort by position');
    expect(store.getState()._historyStack).toHaveLength(4);
    expect(store.getState()._historyStack[3].label).toBe('Sort by position');
    expect(store.getState()._historyStack[3].kind).toBe('sorting');

    store.getState().pushSnapshot('Apply transcription filter');
    store.getState().pushSnapshot('Clear transcription filter');
    expect(store.getState()._historyStack).toHaveLength(5);
    expect(store.getState()._historyStack[4].label).toBe('Clear transcription filter');
    expect(store.getState()._historyStack[4].kind).toBe('filtering');

    expect(store.getState().getHistoryLabels().map(label => label.kind)).toEqual([
      'other',
      'navigation',
      'navigation',
      'sorting',
      'filtering',
    ]);
  });

  it('undo/redo restores viewport for navigation snapshots', () => {
    store.setState({ chrom: 'chr1', start: 1000, end: 2000, clusterK: 3 });
    store.getState().pushSnapshot('Initial');

    store.setState({ chrom: 'chr1', start: 1100, end: 2100, clusterK: 5 });
    store.getState().pushSnapshot('Navigate chr1:1.1k-2.1k');

    store.setState({ chrom: 'chr1', start: 1200, end: 2200, clusterK: 7 });
    store.getState().pushSnapshot('Navigate chr1:1.2k-2.2k');

    store.getState().undo();
    expect(store.getState()).toMatchObject({ chrom: 'chr1', start: 1100, end: 2100, clusterK: 5 });

    store.getState().undo();
    expect(store.getState()).toMatchObject({ chrom: 'chr1', start: 1000, end: 2000, clusterK: 3 });

    store.getState().redo();
    expect(store.getState()).toMatchObject({ chrom: 'chr1', start: 1100, end: 2100, clusterK: 5 });
  });

  it('can seed the previous serialized state for first navigation undo', () => {
    store.setState({ chrom: 'chr2L', start: 1000, end: 2000, clusterK: 3 });
    const previous = serializeState(store.getState());

    store.setState({ chrom: 'chr2L', start: 1500, end: 2500, clusterK: 4 });
    store.getState().pushSerializedSnapshot('Before navigation', previous, { kind: 'navigation' });
    store.getState().pushSnapshot('Navigate chr2L:1.5k-2.5k', { kind: 'navigation' });

    expect(store.getState().canUndo()).toBe(true);
    store.getState().undo();
    expect(store.getState()).toMatchObject({ chrom: 'chr2L', start: 1000, end: 2000, clusterK: 3 });

    store.getState().redo();
    expect(store.getState()).toMatchObject({ chrom: 'chr2L', start: 1500, end: 2500, clusterK: 4 });
  });

  it('undo/redo bumps refresh generation so restored browser state repaints immediately', () => {
    store.setState({ clusterK: 3, refreshGeneration: 7 });
    store.getState().pushSnapshot('Initial cluster settings');

    store.setState({ clusterK: 5 });
    store.getState().pushSnapshot('Changed cluster settings');

    store.getState().undo();
    expect(store.getState().clusterK).toBe(3);
    expect(store.getState().refreshGeneration).toBe(8);

    store.getState().redo();
    expect(store.getState().clusterK).toBe(5);
    expect(store.getState().refreshGeneration).toBe(9);
  });

  it('clearHistory resets the stack', () => {
    store.getState().pushSnapshot('A');
    store.getState().pushSnapshot('B');
    expect(store.getState()._historyStack).toHaveLength(2);

    store.getState().clearHistory();
    expect(store.getState()._historyStack).toHaveLength(0);
    expect(store.getState()._historyPointer).toBe(-1);
  });
});

// ============================================================================
// Selection + cluster focus cross-slice
// ============================================================================

describe('selection + cluster focus cross-slice', () => {
  it('clusterAssignments + clusterFocus + toggleReadSelection → clearReadSelection', () => {
    // Step 1: Set up cluster assignments
    store.setState({
      clusterAssignments: {
        ds1: { read_a: 0, read_b: 1, read_c: 0 },
      },
    });

    // Step 2: Set cluster focus — focus on cluster 0
    store.setState({
      clusterFocus: {
        ds1: new Set([0]),
      },
    });
    expect(store.getState().clusterFocus['ds1']?.has(0)).toBe(true);

    // Step 3: Select individual reads
    store.getState().toggleReadSelection('ds1', 'read_a');
    expect(store.getState().selectedReadIds['ds1']?.has('read_a')).toBe(true);

    store.getState().toggleReadSelection('ds1', 'read_c');
    expect(store.getState().selectedReadIds['ds1']?.size).toBe(2);

    // Step 4: Toggle off one selection
    store.getState().toggleReadSelection('ds1', 'read_a');
    expect(store.getState().selectedReadIds['ds1']?.has('read_a')).toBe(false);
    expect(store.getState().selectedReadIds['ds1']?.size).toBe(1);

    // Step 5: Clear all selections
    store.getState().clearReadSelection();
    expect(Object.keys(store.getState().selectedReadIds)).toHaveLength(0);
  });
});

// ============================================================================
// Bookmark round-trip
// ============================================================================

describe('bookmark round-trip', () => {
  it('setViewport → addBookmark → setViewport (different) → navigateToBookmark → verify coords', () => {
    // Step 1: Set initial viewport
    store.getState().setViewport('chr3R', 6000000, 6020000);
    expect(store.getState().chrom).toBe('chr3R');

    // Step 2: Add bookmark at current location
    store.getState().addBookmark('hsp70 locus');
    const bookmarks = store.getState().bookmarks;
    expect(bookmarks).toHaveLength(1);
    expect(bookmarks[0].name).toBe('hsp70 locus');
    expect(bookmarks[0].chrom).toBe('chr3R');
    expect(bookmarks[0].start).toBe(6000000);

    // Step 3: Navigate away
    store.getState().setViewport('chr3R', 8000000, 8020000);
    expect(store.getState().start).toBe(8000000);

    // Step 4: Navigate back to bookmark
    store.getState().navigateToBookmark(bookmarks[0].id);

    // Step 5: Verify coords restored
    expect(store.getState().chrom).toBe('chr3R');
    expect(store.getState().start).toBe(6000000);
    expect(store.getState().end).toBe(6020000);
  });

  it('removeBookmark removes the bookmark', () => {
    store.getState().addBookmark('test');
    expect(store.getState().bookmarks).toHaveLength(1);

    store.getState().removeBookmark(store.getState().bookmarks[0].id);
    expect(store.getState().bookmarks).toHaveLength(0);
  });
});
