import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  applyImportedState,
  collectFrontendState,
  deserializeSets,
  exportSession,
  importSession,
  SESSION_PRE_VIEWPORT_KEYS,
} from './session';
import { useBrowserStore } from '../stores/browserStore';
import { useCoaccStore } from '../stores/coaccStore';
import { useDafcStore } from '../stores/dafcStore';
import { useReadActionsStore } from '../stores/readActionsStore';

beforeEach(() => {
  localStorage.clear();
  useCoaccStore.setState({
    coaccTrackMode: null,
    coaccSignalType: 'accessibility',
    coaccLayer: null,
    coaccNormalization: 'correlation',
    coaccScaling: 'linear',
    coaccColormap: 'fall',
    coaccMinCoverage: 20,
    coaccBinSize: 0,
    coaccArcThreshold: 1.5,
    coaccArcMaxArcs: 200,
    coaccArcMinDistance: 2,
    coaccV4cViewpoint: null,
  });
  useDafcStore.setState({
    dafcLoaded: false,
    dafcResolution: 10000,
    dafcResolutions: [],
    linkedSessions: [],
    currentLinkedSessionId: null,
    linkedReadCount: 0,
    linkedVersion: 0,
  });
  useBrowserStore.setState({
    clickTargetLayer: null,
    footprintAnalysisLayer: null,
    readScrollOffsets: {},
    showGenomeOverview: true,
    publicMode: false,
    catalog: [],
    compositeTracks: [],
    savedTracks: [],
    _historyStack: [],
    _historyPointer: -1,
    _lastRestoreTime: 0,
  } as any);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('session Set hydration', () => {
  it('hydrates serialized Set fields used by .has callers', () => {
    const batch: Record<string, unknown> = {
      clusterFocus: { ds1: [1, 2] },
      filteredReadIds: { ds1: ['r1'] },
      selectedReadIds: { ds1: ['r2'] },
      selectedPeaks: [7],
      selectedDatasets: ['panel-1'],
      collapsedRows: [0],
      hiddenStripPanels: ['read-stats'],
    };

    deserializeSets(batch);

    expect(batch.clusterFocus).toEqual({ ds1: new Set([1, 2]) });
    expect(batch.filteredReadIds).toEqual({ ds1: new Set(['r1']) });
    expect(batch.selectedReadIds).toEqual({ ds1: new Set(['r2']) });
    expect(batch.selectedPeaks).toEqual(new Set([7]));
    expect(batch.selectedDatasets).toEqual(new Set(['panel-1']));
    expect(batch.collapsedRows).toEqual(new Set([0]));
    expect(batch.hiddenStripPanels).toEqual(new Set(['read-stats']));
  });

  it('turns an older snapshot\'s open sections into the settings page shown', () => {
    const legacy: Record<string, unknown> = { openSections: ['history', 'view', 'file'] };
    deserializeSets(legacy);
    expect(legacy).toEqual({ activeSection: 'view' });
    const junk: Record<string, unknown> = { openSections: {}, activeSection: 42 };
    deserializeSets(junk);
    expect(junk).toEqual({});
  });

  it('tolerates legacy object-shaped Set values', () => {
    const batch: Record<string, unknown> = {
      selectedPeaks: { values: [3, 4] },
      clusterFocus: { ds1: { 0: 7, 1: 8 } },
      selectedReadIds: { ds1: null },
      hiddenStripPanels: {},
    };

    deserializeSets(batch);

    expect(batch.selectedPeaks).toEqual(new Set([3, 4]));
    expect(batch.clusterFocus).toEqual({ ds1: new Set([7, 8]) });
    expect(batch.selectedReadIds).toEqual({ ds1: new Set() });
    expect(batch.hiddenStripPanels).toEqual(new Set());
  });
});

describe('session frontend restore coverage', () => {
  it('keeps import restore keys aligned with newer serialized frontend fields', () => {
    expect([...SESSION_PRE_VIEWPORT_KEYS]).toEqual(expect.arrayContaining([
      'clickTargetLayer',
      'footprintAnalysisLayer',
      'readScrollOffsets',
      'showGenomeOverview',
      'publicMode',
      'catalog',
      'compositeTracks',
      'savedTracks',
    ]));
  });

  it('applies newer frontend fields during in-place session import', () => {
    const catalog = [{
      id: 'cat-tf',
      source: 'local',
      kind: 'bigbed',
      label: 'TF motifs',
      path: '/tmp/tf.bb',
      loaded: true,
    }];
    const compositeTracks = [{
      id: 'comp-tf',
      label: 'TF track',
      kind: 'annotation',
      sources: [],
      scaleMode: 'auto',
      logScale: false,
      visible: true,
      groupAutoscaleSelected: false,
      showAxes: true,
    }];
    const savedTracks = [{
      id: 'saved-tf',
      name: 'TF preset',
      savedAt: '2026-04-30T00:00:00.000Z',
      composite: {
        label: 'TF preset',
        kind: 'annotation',
        sources: [],
        scaleMode: 'auto',
        logScale: false,
        visible: true,
        groupAutoscaleSelected: false,
        showAxes: true,
      },
    }];

    applyImportedState({
      datasets: [],
      overlays: [],
      has_fasta: false,
      frontend: {
        clickTargetLayer: 'tf',
        footprintAnalysisLayer: 'nuc',
        readScrollOffsets: { ds1: 72 },
        showGenomeOverview: false,
        publicMode: true,
        interactionMode: 'read',  // saved while click modes existed: ignored
        catalog,
        compositeTracks,
        savedTracks,
      },
      viewport: { chrom: 'chr2R', start: 1000, end: 2000 },
    });

    const state = useBrowserStore.getState();
    expect(state.clickTargetLayer).toBe('tf');
    expect(state.footprintAnalysisLayer).toBe('nuc');
    expect(state.readScrollOffsets).toEqual({});
    expect(state.showGenomeOverview).toBe(false);
    expect(state.publicMode).toBe(true);
    expect('interactionMode' in state).toBe(false);
    expect(state.catalog).toEqual(catalog);
    expect(state.compositeTracks).toEqual(compositeTracks);
    expect(state.savedTracks).toEqual(savedTracks);
    expect(state.chrom).toBe('chr2R');
    expect(state.start).toBe(1000);
    expect(state.end).toBe(2000);
  });

  it("opening a session forgets the last one's read highlights, pins and exclusions (fb-r4-clicks)", () => {
    useReadActionsStore.getState().excludeReads('ds1', ['r1']);
    useReadActionsStore.getState().pulseReads(['r2']);
    const epoch = useReadActionsStore.getState().epoch;
    applyImportedState({ datasets: [], overlays: [], has_fasta: false, frontend: {}, viewport: { chrom: 'chr2R', start: 1000, end: 2000 } });
    const s = useReadActionsStore.getState();
    expect(s.excludedReadIds).toEqual({});
    expect(s.highlight).toBeNull();
    expect(s.pinnedReadIds).toEqual([]);
    expect(s.epoch).toBe(epoch + 1);
  });

  it('normalizes legacy MSP aliases while importing session state', () => {
    applyImportedState({
      datasets: [],
      overlays: [],
      has_fasta: false,
      frontend: {
        clickTargetLayer: 'msp',
        footprintAnalysisLayer: 'all',
        enabledModTypes: { msp: true },
        enabledMetaProfiles: { msp: true },
        cachedLayerTypes: { msp: false },
        activeColormap: {
          name: 'Legacy MSP labels',
          rules: [{
            id: 'rule-msp',
            name: 'MSP rule',
            color: '#f97316',
            sizeMin: 1,
            sizeMax: 80,
            targetLayers: ['msp', 'fire'],
            conditions: [],
            enabled: true,
          }],
          qualityShading: { enabled: false, mode: 'quality', vizMode: 'opacity', invert: false, minOpacity: 0.2, maxOpacity: 1 },
          tfOverlay: { enabled: false, color: '#e040fb', minOpacity: 0.2, maxOpacity: 0.85, minTq: 0 },
          qualityFilters: [{ layer: 'msp', qualityName: 'aq', minValue: 230, enabled: true }],
        },
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
        }],
        coaccSettings: {
          coaccTrackMode: 'heatmap',
          coaccSignalType: 'accessibility',
          coaccLayer: 'msp',
          coaccNormalization: 'correlation',
          coaccScaling: 'linear',
          coaccColormap: 'fall',
          coaccMinCoverage: 20,
          coaccBinSize: 0,
          coaccArcThreshold: 1.5,
          coaccArcMaxArcs: 200,
          coaccArcMinDistance: 2,
          coaccV4cViewpoint: null,
        },
      },
      viewport: { chrom: 'chr2R', start: 1000, end: 2000 },
    });

    const state = useBrowserStore.getState();
    expect(state.clickTargetLayer).toBe('fire');
    expect(state.footprintAnalysisLayer).toBeNull();
    expect(state.enabledModTypes).toEqual({ fire: true });
    expect(state.enabledMetaProfiles).toEqual({ fire: true });
    expect(state.cachedLayerTypes).toEqual({ fire: false });
    expect(state.activeColormap.qualityFilters[0].layer).toBe('fire');
    expect(state.activeColormap.rules[0].targetLayers).toEqual(['fire']);
    expect(state.footprintGroups[0].layer).toBe('fire');
    expect(useCoaccStore.getState().coaccLayer).toBe('fire');
  });

  it('round-trips reproducibility-critical session state through export/import helpers', () => {
    const peakRules = [{ id: 'rule-a', name: 'TF', source: 'tf_layer', enabled: true }];
    const peaksByRule = {
      'rule-a': [{ index: 1, chrom: 'chr2L', start: 100, end: 160, source: 'tf_layer' }],
    };
    const captureRegions = [{
      id: 'cap1',
      name: 'capture_1',
      chrom: 'chr2L',
      start: 100,
      end: 200,
      padding: 50,
      addedAt: 1,
      source: 'viewport',
    }];
    const activeColormap = {
      name: 'Paper labels',
      backgroundColor: '#020617',
      readBackgroundColor: '#111827',
      noReadBackgroundColor: '#020617',
      rules: [],
      qualityShading: { enabled: false, mode: 'quality', vizMode: 'opacity', invert: false, minOpacity: 0.2, maxOpacity: 1 },
      tfOverlay: { enabled: true, color: '#e040fb', minOpacity: 0.2, maxOpacity: 0.85, minTq: 0 },
      layerOpacities: { nuc: 1, tf: 0.9, nuc_sr: 0.9, tf_sr: 0.9, fire: 0.55 },
      layerBackgroundOpacities: { nuc: 0, tf: 1, nuc_sr: 1, tf_sr: 1, fire: 0.25 },
      displaySmoothing: { enabled: true, sigmaX: 2, sigmaY: 0.5 },
      qualityFilters: [{ layer: 'fire', qualityName: 'aq', minValue: 230, enabled: true }],
      edgeAmbiguity: { mode: 'strict', applyNuc: true, applyTf: true, maxGapBp: 30 },
    };
    const footprintGroups = [{
      id: 'fg1',
      name: 'TF class',
      color: '#e040fb',
      layer: 'tf',
      sizeMin: 1,
      sizeMax: 35,
      referenceAbsStart: 125,
      referenceAbsEnd: 155,
      overlapFraction: 0.5,
      familyId: null,
      minFamilyConfidence: 0,
      familyBoundaryMode: 'both',
      familyModelAbsStart: null,
      familyModelAbsEnd: null,
      autoGeneratedFamily: false,
      familyCatalogId: null,
      familyCatalogFrozen: false,
      familyCatalogChrom: null,
      familyCatalogAbsStart: null,
      familyCatalogAbsEnd: null,
      sourceDatasetId: null,
      sourceViewKey: null,
      enabled: true,
      sourceIndex: -1,
    }];
    const catalog = [{ id: 'cat1', source: 'local', kind: 'bigbed', label: 'Motifs', path: '/tmp/tf.bb', loaded: true }];
    const compositeTracks = [{
      id: 'comp1',
      label: 'TF motifs',
      kind: 'annotation',
      sources: [],
      scaleMode: 'auto',
      logScale: false,
      visible: true,
      groupAutoscaleSelected: false,
      showAxes: true,
    }];
    const savedTracks = [{
      id: 'saved1',
      name: 'TF preset',
      savedAt: '2026-04-30T00:00:00.000Z',
      composite: {
        label: 'TF preset',
        kind: 'annotation',
        sources: [],
        scaleMode: 'auto',
        logScale: false,
        visible: true,
        groupAutoscaleSelected: false,
        showAxes: true,
      },
    }];

    useBrowserStore.setState({
      chrom: 'chr2L',
      start: 100,
      end: 300,
      datasets: [{
        id: 'ds1',
        label: 'BAM',
        path: '/tmp/a.bam',
        paths: ['/tmp/a.bam'],
        color: '#111',
        data_type: 'bam',
        available_layers: { nuc: true, tf: true },
      }] as any,
      analysisSampleSeed: 'paper-seed',
      clusterPreparationCount: 10000,
      clusterPreparationSamples: { ds1: { target_names: 10000, selected_names: 10000,
        total_alignments: 100000, prepared_reads: 9000, used: 5000, fingerprint: 'abc',
        sample_seed: 'paper-seed', method: 'bottom_k_qname_v1', chrom: 'chr2L', start: 100, end: 300 } },
      analysisSampleCount: 5000,
      downsampleCount: 1000,
      readDisplayMode: 'all',
      allReadsDisplayCap: 15000,
      spanningOnly: true,
      peaksLocked: true,
      selectedPeaks: new Set([1]),
      peakRules: peakRules as any,
      peaksByRule: peaksByRule as any,
      clusterAssignments: { ds1: { read1: 0, read2: 1 } },
      clusterOrder: { ds1: [0, 1] },
      captureRegions: captureRegions as any,
      capturePadding: 50,
      activeColormap: activeColormap as any,
      footprintGroups: footprintGroups as any,
      catalog: catalog as any,
      compositeTracks: compositeTracks as any,
      savedTracks: savedTracks as any,
      commandHistory: [{
        id: 'command-1', text: 'compare cluster rates', status: 'success',
        actions: [], timestamp: 123,
      }],
    } as any);
    useCoaccStore.setState({
      coaccTrackMode: 'arc',
      coaccSignalType: 'small_fp',
      coaccLayer: 'tf',
      coaccNormalization: 'oe_distance',
      coaccScaling: 'sqrt',
      coaccColormap: 'viridis',
      coaccMinCoverage: 35,
      coaccBinSize: 250,
      coaccArcThreshold: 2.5,
      coaccArcMaxArcs: 75,
      coaccArcMinDistance: 4,
      coaccV4cViewpoint: { start: 120, end: 140, label: 'vp' },
    });

    const exported = collectFrontendState();
    expect(exported.sessionManifest).toMatchObject({
      sessionName: 'Untitled session',
      labeling: {
        presetName: 'Paper labels',
        readBackgroundColor: '#111827',
        noReadBackgroundColor: '#020617',
        displaySmoothing: { enabled: true, sigmaX: 2, sigmaY: 0.5 },
        layerOpacities: { fire: 0.55, nuc: 1, nuc_sr: 0.9, tf: 0.9, tf_sr: 0.9 },
        layerBackgroundOpacities: { fire: 0.25, nuc: 0, nuc_sr: 1, tf: 1, tf_sr: 1 },
        qualityFilters: ['fire.aq>=230'],
      },
      reproducibility: {
        seed: 'paper-seed',
        analysisCap: 5000,
        displayCap: 1000,
        displayMode: 'all',
        allReadsDisplayCap: 15000,
        peaksLocked: true,
        selectedPeaks: 1,
        footprintRules: {
          total: 1,
          enabled: 1,
          pinned: 1,
        },
      },
    });
    expect(exported.coaccSettings).toMatchObject({
      coaccTrackMode: 'arc',
      coaccSignalType: 'small_fp',
      coaccLayer: 'tf',
      coaccNormalization: 'oe_distance',
      coaccScaling: 'sqrt',
      coaccColormap: 'viridis',
      coaccMinCoverage: 35,
      coaccBinSize: 250,
      coaccArcThreshold: 2.5,
      coaccArcMaxArcs: 75,
      coaccArcMinDistance: 4,
      coaccV4cViewpoint: { start: 120, end: 140, label: 'vp' },
    });

    useBrowserStore.setState({
      analysisSampleSeed: 'changed',
      analysisSampleCount: null,
      downsampleCount: null,
      readDisplayMode: 'sample',
      allReadsDisplayCap: 10000,
      peaksLocked: false,
      selectedPeaks: new Set(),
      peakRules: [],
      peaksByRule: {},
      clusterAssignments: {},
      clusterOrder: {},
      captureRegions: [],
      capturePadding: 0,
      footprintGroups: [],
      catalog: [],
      compositeTracks: [],
      savedTracks: [],
      commandHistory: [],
    } as any);
    useCoaccStore.setState({
      coaccTrackMode: null,
      coaccSignalType: 'accessibility',
      coaccLayer: null,
      coaccNormalization: 'correlation',
      coaccScaling: 'linear',
      coaccColormap: 'fall',
      coaccMinCoverage: 20,
      coaccBinSize: 0,
      coaccArcThreshold: 1.5,
      coaccArcMaxArcs: 200,
      coaccArcMinDistance: 2,
      coaccV4cViewpoint: null,
    });

    applyImportedState({
      datasets: useBrowserStore.getState().datasets,
      overlays: [],
      has_fasta: false,
      frontend: exported,
      viewport: { chrom: 'chr2L', start: 100, end: 300 },
    });

    const restored = useBrowserStore.getState();
    expect(restored.analysisSampleSeed).toBe('paper-seed');
    expect(restored.clusterPreparationCount).toBe(10000);
    expect(restored.clusterPreparationSamples.ds1).toMatchObject({ fingerprint: 'abc', used: 5000 });
    expect(restored.analysisSampleCount).toBe(5000);
    expect(restored.downsampleCount).toBe(1000);
    expect(restored.readDisplayMode).toBe('all');
    expect(restored.allReadsDisplayCap).toBe(15000);
    expect(restored.peaksLocked).toBe(true);
    expect(restored.selectedPeaks).toEqual(new Set([1]));
    expect(restored.peakRules).toEqual(peakRules);
    expect(restored.peaksByRule).toEqual(peaksByRule);
    expect(restored.clusterAssignments).toEqual({ ds1: { read1: 0, read2: 1 } });
    expect(restored.clusterOrder).toEqual({ ds1: [0, 1] });
    expect(restored.captureRegions).toEqual(captureRegions);
    expect(restored.capturePadding).toBe(50);
    expect(restored.activeColormap).toEqual(activeColormap);
    expect(restored.footprintGroups).toEqual(footprintGroups);
    expect(restored.catalog).toEqual(catalog);
    expect(restored.compositeTracks).toEqual(compositeTracks);
    expect(restored.savedTracks).toEqual(savedTracks);
    expect(restored.commandHistory).toEqual([{
      id: 'command-1', text: 'compare cluster rates', status: 'success',
      actions: [], timestamp: 123,
    }]);
    expect(useCoaccStore.getState()).toMatchObject({
      coaccTrackMode: 'arc',
      coaccSignalType: 'small_fp',
      coaccLayer: 'tf',
      coaccNormalization: 'oe_distance',
      coaccScaling: 'sqrt',
      coaccColormap: 'viridis',
      coaccMinCoverage: 35,
      coaccBinSize: 250,
      coaccArcThreshold: 2.5,
      coaccArcMaxArcs: 75,
      coaccArcMinDistance: 4,
      coaccV4cViewpoint: { start: 120, end: 140, label: 'vp' },
    });
  });

  it('restores co-accessibility sidecar settings from history snapshots', () => {
    useCoaccStore.setState({
      coaccTrackMode: 'heatmap',
      coaccSignalType: 'all_fp',
      coaccLayer: 'fire',
      coaccNormalization: 'raw',
      coaccScaling: 'log',
      coaccColormap: 'hot',
      coaccMinCoverage: 45,
      coaccBinSize: 500,
      coaccArcThreshold: 3,
      coaccArcMaxArcs: 50,
      coaccArcMinDistance: 5,
      coaccV4cViewpoint: { start: 100, end: 100 },
    });

    useBrowserStore.getState().pushSnapshot('Coacc settings', { kind: 'analysis' });
    useCoaccStore.setState({
      coaccTrackMode: null,
      coaccSignalType: 'accessibility',
      coaccLayer: null,
      coaccNormalization: 'correlation',
      coaccScaling: 'linear',
      coaccColormap: 'fall',
      coaccMinCoverage: 20,
      coaccBinSize: 0,
      coaccArcThreshold: 1.5,
      coaccArcMaxArcs: 200,
      coaccArcMinDistance: 2,
      coaccV4cViewpoint: null,
    });

    useBrowserStore.getState().restoreSnapshot(0);

    expect(useCoaccStore.getState()).toMatchObject({
      coaccTrackMode: 'heatmap',
      coaccSignalType: 'all_fp',
      coaccLayer: 'fire',
      coaccNormalization: 'raw',
      coaccScaling: 'log',
      coaccColormap: 'hot',
      coaccMinCoverage: 45,
      coaccBinSize: 500,
      coaccArcThreshold: 3,
      coaccArcMaxArcs: 50,
      coaccArcMinDistance: 5,
      coaccV4cViewpoint: { start: 100, end: 100 },
    });
  });

  it('clamps imported history pointers and skips malformed snapshots', () => {
    const snapshotState = collectFrontendState();

    applyImportedState({
      datasets: [],
      overlays: [],
      has_fasta: false,
      frontend: {
        historySnapshots: [
          null,
          { label: 'Initial state', timestamp: 1, state: snapshotState },
          { label: 'Missing state', timestamp: 2 },
          { label: 'Clustered', timestamp: 3, state: { ...snapshotState, clusterK: 6 } },
        ],
        historyPointer: 99,
      },
      viewport: { chrom: 'chr2R', start: 1000, end: 2000 },
    });

    const state = useBrowserStore.getState();
    expect(state._historyStack.map(s => s.label)).toEqual(['Initial state', 'Clustered']);
    expect(state._historyPointer).toBe(1);
  });

  it('restores analysis state that navigating to the saved chromosome would clear', () => {
    useBrowserStore.setState({ chrom: '3L', start: 1, end: 5000 } as any);
    const gene = { id: 'eve', name: 'eve', chrom: '2R', start: 1500, end: 1800, strand: '+' };
    const groups = [{ id: 'g1', name: 'Group 1', color: '#f00', footprints: [] }];

    applyImportedState({
      datasets: [], overlays: [], has_fasta: false,
      frontend: {
        footprintGroups: groups,
        selectedGenes: [gene],
        showRelativeCoords: true,
        relativeTSS: 1500,
        relativeGene: gene,
        supplementalUiState: { dismissedPanelTypes: ['capture'], openSections: ['analysis', 'file'] },
      },
      viewport: { chrom: '2R', start: 1000, end: 2000 },
    });
    // An older session's open sections: the first is the settings page shown.
    expect(useBrowserStore.getState().activeSection).toBe('analysis');

    const state = useBrowserStore.getState();
    expect(state.chrom).toBe('2R');
    expect(state.footprintGroups.map(g => g.id)).toEqual(['g1']);
    expect(state.selectedGenes.map(g => g.id)).toEqual(['eve']);
    expect([state.showRelativeCoords, state.relativeTSS, state.relativeGene?.id]).toEqual([true, 1500, 'eve']);
    expect([...state.dismissedPanelTypes]).toEqual(['capture']);
  });

  it('saves and restores the settings page shown', () => {
    useBrowserStore.setState({ activeSection: 'genome' } as any);
    const saved = collectFrontendState() as any;
    expect(saved.supplementalUiState).toMatchObject({ activeSection: 'genome', openSections: ['genome'] });
    useBrowserStore.setState({ activeSection: 'file' } as any);
    applyImportedState({ datasets: [], overlays: [], has_fasta: false, frontend: saved });
    expect(useBrowserStore.getState().activeSection).toBe('genome');
  });

  it('a session without panels gets default panels for its own datasets, not the old ones', () => {
    useBrowserStore.setState({
      datasets: [{ id: 'A', label: 'A' }],
      panels: [{ id: 'panel-A', contentType: 'dataset', datasetId: 'A', subTracks: [], collapsed: false, layoutRow: 0 }],
      selectedDatasets: new Set(['panel-A']),
      fullViewPanelId: 'panel-A',
    } as any);

    applyImportedState({
      datasets: [{ id: 'B', label: 'B', path: '/b.bam' }] as any, overlays: [], has_fasta: false,
      frontend: { clusterK: 4 },
    });

    const state = useBrowserStore.getState();
    const datasetPanels = state.panels.filter(p => p.contentType === 'dataset');
    expect(datasetPanels.map(p => p.datasetId)).toEqual(state.datasets.map(d => d.id));
    expect(datasetPanels.some(p => p.id === 'panel-A')).toBe(false);
    expect(state.selectedDatasets.has('panel-A')).toBe(false);
    expect(state.fullViewPanelId).toBeNull();
  });

  // fb-r2-genomes: per-panel references and loci, and the navigation mode, come back; older sessions open linked.
  it('restores panels on their own references and the navigation mode; an older session opens linked', () => {
    const fly = { id: 'panel-fly', contentType: 'dataset', datasetId: 'fly', subTracks: [], collapsed: false, layoutRow: 0,
      linkGroup: null, genome: 'dm6', viewportOverride: { chrom: 'chr2R', start: 100, end: 900 } };
    const human = { id: 'panel-h', contentType: 'dataset', datasetId: 'h', subTracks: [], collapsed: false, layoutRow: 0,
      linkGroup: null, navOwn: true, viewportOverride: { chrom: 'chr19', start: 5, end: 50 } };
    applyImportedState({
      datasets: [{ id: 'h', label: 'h', path: '/h.bam' }, { id: 'fly', label: 'fly', path: '/f.bam' }] as any, overlays: [], has_fasta: true,
      frontend: { panels: [human, fly], navigationMode: 'perPanel' },
    });
    let state = useBrowserStore.getState();
    expect(state.navigationMode).toBe('perPanel');
    expect(state.panels.find(p => p.id === 'panel-fly')).toMatchObject({ genome: 'dm6', viewportOverride: fly.viewportOverride });
    expect(state.panels.find(p => p.id === 'panel-h')).toMatchObject({ navOwn: true, viewportOverride: human.viewportOverride });

    const plain = { ...human, navOwn: undefined, viewportOverride: undefined };
    applyImportedState({
      datasets: [{ id: 'h', label: 'h', path: '/h.bam' }] as any, overlays: [], has_fasta: true,
      frontend: { panels: [plain] },
    });
    state = useBrowserStore.getState();
    expect(state.navigationMode).toBe('linked');
    expect(state.panels.find(p => p.id === 'panel-h')!.viewportOverride).toBeUndefined();
  });

  it("drops the previous session's clustering when the imported one has none", () => {
    useBrowserStore.setState({
      chrom: '2R', start: 1000, end: 2000,
      clusterAssignments: { ds1: { r1: 0, r2: 1 } },
      clusterPatterns: { 0: [1, 0] } as any,
      dynamicClustering: true,
      filteredReadIds: { ds1: new Set(['r1']) },
      selectedClusters: { ds1: new Set([1]) },
    } as any);

    // A session saved without frontend state, at an overlapping view.
    applyImportedState({
      datasets: [{ id: 'ds1', label: 'ds1', path: '/other.bam' }] as any, overlays: [], has_fasta: false,
      viewport: { chrom: '2R', start: 1100, end: 2100 },
    });

    const state = useBrowserStore.getState();
    expect(state.clusterAssignments).toEqual({});
    expect(state.clusterPatterns).toEqual({});
    expect(state.dynamicClustering).toBe(false);
    expect(state.filteredReadIds).toEqual({});
    expect(state.selectedClusters).toEqual({});
  });

  it("a session saved without cluster-by choices doesn't inherit the previous session's", () => {
    useBrowserStore.setState({
      cooccClusterSelections: [{ chrom: '2R', start: 1000, end: 2000, groupIds: [] }],
    } as any);
    applyImportedState({
      datasets: [{ id: 'ds1', label: 'ds1', path: '/other.bam' }] as any, overlays: [], has_fasta: false,
      viewport: { chrom: '2R', start: 1100, end: 2100 }, frontend: { sessionName: 'old' },
    });
    expect(useBrowserStore.getState().cooccClusterSelections).toEqual([]);
    applyImportedState({
      datasets: [{ id: 'ds1', label: 'ds1', path: '/other.bam' }] as any, overlays: [], has_fasta: false,
      viewport: { chrom: '2R', start: 1100, end: 2100 },
      frontend: { cooccClusterSelections: [{ chrom: '2R', start: 1, end: 9, groupIds: ['a'] }] },
    });
    expect(useBrowserStore.getState().cooccClusterSelections).toEqual([{ chrom: '2R', start: 1, end: 9, groupIds: ['a'] }]);
  });

  it('restores saved cluster selections as Sets', () => {
    applyImportedState({
      datasets: [{ id: 'ds1', label: 'ds1', path: '/a.bam' }] as any, overlays: [], has_fasta: false,
      frontend: {
        chrom: '2R', start: 1000, end: 2000,
        clusterAssignments: { ds1: { r1: 3, r2: 1 } },
        selectedClusters: { ds1: [3] },
      },
      viewport: { chrom: '2R', start: 1000, end: 2000 },
    });

    const selected = useBrowserStore.getState().selectedClusters.ds1;
    expect(selected instanceof Set).toBe(true);
    expect([...(selected ?? [])]).toEqual([3]);
  });

  it('a session without history replaces the old undo stack', () => {
    const snapshotState = collectFrontendState();
    useBrowserStore.setState({
      _historyStack: [{ label: 'Old edit', timestamp: 1, state: snapshotState }],
      _historyPointer: 0,
    } as any);

    applyImportedState({ datasets: [], overlays: [], has_fasta: false, frontend: { clusterK: 4 } });

    expect(useBrowserStore.getState()._historyStack).toEqual([]);
    expect(useBrowserStore.getState()._historyPointer).toBe(-1);
  });

  it('a session without frontend state (backend-only or older file) replaces the old undo stack too (Codex 7)', () => {
    const snapshotState = collectFrontendState();
    useBrowserStore.setState({
      _historyStack: [{ label: 'Old edit', timestamp: 1, state: snapshotState }, { label: 'Older edit', timestamp: 2, state: snapshotState }],
      _historyPointer: 1,
    } as any);

    applyImportedState({ datasets: [], overlays: [], has_fasta: false });

    expect(useBrowserStore.getState()._historyStack).toEqual([]);
    expect(useBrowserStore.getState()._historyPointer).toBe(-1);
    expect(useBrowserStore.getState().canUndo()).toBe(false);
  });

  it('saves reads hidden with "Exclude selected" and opens them with the session (Codex 16)', () => {
    useReadActionsStore.getState().excludeReads('ds1', ['r2', 'r1']);
    const saved = collectFrontendState();
    expect(saved.excludedReadIds).toEqual({ ds1: ['r1', 'r2'] });
    useReadActionsStore.getState().reset();

    applyImportedState({ datasets: [], overlays: [], has_fasta: false, frontend: saved, viewport: { chrom: 'chr2R', start: 1000, end: 2000 } });
    expect([...useReadActionsStore.getState().excludedReadIds.ds1]).toEqual(['r1', 'r2']);
  });

  it('saves the Sort selector choice the reads were sorted by (L9)', () => {
    useBrowserStore.setState({ sortSelection: 'projection' } as any);
    const saved = collectFrontendState();
    useBrowserStore.setState({ sortSelection: null } as any);
    applyImportedState({ datasets: [], overlays: [], has_fasta: false, frontend: saved });
    expect(useBrowserStore.getState().sortSelection).toBe('projection');
  });

  it('restores the primer BLAST database and saved primers, keeping the rest of primer state', () => {
    const saved = [{ id: 'p1', name: 'pair 1' }];
    useBrowserStore.setState({ primer: { ...useBrowserStore.getState().primer, configFasta: 'genome.fa', savedPrimers: [] } } as any);

    applyImportedState({
      datasets: [], overlays: [], has_fasta: false,
      frontend: { primerConfigBlastDb: 'dm6', primerSavedPrimers: saved },
    });

    const primer = useBrowserStore.getState().primer;
    expect(primer.configBlastDb).toBe('dm6');
    expect(primer.savedPrimers).toEqual(saved);
    expect(primer.configFasta).toBe('genome.fa');
  });

  it('restores imported history snapshots with legacy Set encodings', () => {
    const snapshotState = collectFrontendState();

    applyImportedState({
      datasets: [],
      overlays: [],
      has_fasta: false,
      frontend: {
        historySnapshots: [
          {
            label: 'Legacy encoded sets',
            timestamp: 1,
            state: {
              ...snapshotState,
              selectedPeaks: { values: [11] },
              selectedDatasets: { 0: 'panel-legacy' },
              filteredReadIds: { ds1: { 0: 'read-a', 1: 'read-b' } },
              clusterFocus: { ds1: { values: [2] } },
              selectedReadIds: { ds1: { 0: 'read-a' } },
              hiddenStripPanels: { 0: 'history' },
              collapsedRows: { 0: 1 },
            },
          },
        ],
        historyPointer: 0,
      },
      viewport: { chrom: 'chr2R', start: 1000, end: 2000 },
    });

    useBrowserStore.getState().restoreSnapshot(0);

    const state = useBrowserStore.getState();
    expect(state.selectedPeaks).toEqual(new Set([11]));
    expect(state.selectedDatasets).toEqual(new Set(['panel-legacy']));
    expect(state.filteredReadIds.ds1).toEqual(new Set(['read-a', 'read-b']));
    expect(state.clusterFocus.ds1).toEqual(new Set([2]));
    expect(state.selectedReadIds.ds1).toEqual(new Set(['read-a']));
    expect(state.hiddenStripPanels).toEqual(new Set(['history']));
    expect(state.collapsedRows).toEqual(new Set([1]));
  });

  it('keeps the closed datasets of imported history steps so Undo can still reopen them', () => {
    const snapshotState = collectFrontendState();
    const closed = { id: 'b', label: 'napa_hia5', paths: ['/data/napa_hia5.bam'], color: '#ef4444', data_type: 'bam' };
    applyImportedState({
      datasets: [], overlays: [], has_fasta: false,
      frontend: {
        historySnapshots: [
          { label: 'Before closing napa_hia5', timestamp: 1, state: snapshotState },
          { label: 'Close napa_hia5', timestamp: 2, state: snapshotState, closedDatasets: [closed, { id: 'junk' }] },
        ],
        historyPointer: 1,
      },
      viewport: { chrom: 'chr2R', start: 1000, end: 2000 },
    });
    const stack = useBrowserStore.getState()._historyStack;
    expect(stack[0].closedDatasets).toBeUndefined();
    expect(stack[1].closedDatasets).toEqual([closed]);
  });

  it('drops the removed hyperburst Pol II state from legacy sessions and snapshots', () => {
    const hyperTerm = { id: 't1', source: 'transcription_state', transcriptionState: 'hyperburst' };
    const pauseTerm = { id: 't1', source: 'transcription_state', transcriptionState: 'pause' };
    const legacyFilters = { pause: true, pic: false, elongating: 2, elongating_max: null, hyperburst: true };
    const legacyRules = {
      clusterFeatureRules: [
        { id: 'c-hyper', name: 'Hyper', enabled: true, terms: [hyperTerm] },
        { id: 'c-pause', name: 'Pause', enabled: true, terms: [pauseTerm] },
      ],
      analysisSortRules: [
        { id: 's-hyper', name: 'Hyper', enabled: true, terms: [hyperTerm], metric: 'count', descending: true },
        { id: 's-pause', name: 'Pause', enabled: true, terms: [pauseTerm], metric: 'count', descending: true },
      ],
      analysisFilterRules: [
        { id: 'f-hyper', name: 'Hyper', enabled: true, terms: [hyperTerm], metric: 'count', operator: 'gte', threshold: 1 },
        { id: 'f-pause', name: 'Pause', enabled: true, terms: [pauseTerm], metric: 'count', operator: 'gte', threshold: 1 },
      ],
    };
    const snapshotState = collectFrontendState();

    applyImportedState({
      datasets: [],
      overlays: [],
      has_fasta: false,
      frontend: {
        transcriptionStateFilters: legacyFilters,
        ...legacyRules,
        historySnapshots: [{
          label: 'Legacy hyperburst',
          timestamp: 1,
          state: { ...snapshotState, transcriptionStateFilters: legacyFilters, ...legacyRules },
        }],
        historyPointer: 0,
      },
      viewport: { chrom: 'chr2R', start: 1000, end: 2000 },
    });

    const expectCurrentOnly = () => {
      const state = useBrowserStore.getState();
      expect('hyperburst' in state.transcriptionStateFilters).toBe(false);
      expect(state.clusterFeatureRules.map(rule => rule.id)).toEqual(['c-pause']);
      expect(state.analysisSortRules.map(rule => rule.id)).toEqual(['s-pause']);
      expect(state.analysisFilterRules.map(rule => rule.id)).toEqual(['f-pause']);
      expect(state.analysisFilterRules[0].terms[0].transcriptionState).toBe('pause');
    };
    expectCurrentOnly();

    useBrowserStore.setState({ transcriptionStateFilters: { pause: false }, clusterFeatureRules: [], analysisSortRules: [], analysisFilterRules: [] } as any);
    useBrowserStore.getState().restoreSnapshot(0);
    expectCurrentOnly();
    expect(useBrowserStore.getState().transcriptionStateFilters)
      .toEqual({ pause: true, pic: false, elongating: 2, elongating_max: null });

    // Jupyter/API updates carrying the legacy flag are ignored too.
    useBrowserStore.getState().setTranscriptionStateFilters({ hyperburst: true } as any);
    expect('hyperburst' in useBrowserStore.getState().transcriptionStateFilters).toBe(false);
  });

  it('uses successfully restored annotations instead of saved phantom files', () => {
    applyImportedState({
      datasets: [], overlays: [], has_fasta: false,
      annotations: [{
        id: 'present', path: '/data/present.bb', label: 'Present', active: true,
        dataset_ids: ['ds1'],
        annotation_types: [{ name: 'ctcf', category: 'factor', description: '', color: '#123456' }],
      }],
      frontend: {
        annotationSettings: {
          annotationFiles: [{ id: 'missing', path: '/gone.bb', label: 'Missing', active: true }],
          enabledAnnotationTypes: { ctcf: true },
          annotationThresholds: { ctcf: 0.8 },
          annotationColors: { ctcf: '#123456' },
        },
      },
    });

    expect(useBrowserStore.getState().annotationFiles).toEqual([{
      id: 'present', path: '/data/present.bb', label: 'Present', active: true,
      datasetIds: ['ds1'],
      annotationTypes: [{ name: 'ctcf', category: 'factor', description: '', color: '#123456' }],
    }]);
  });

  it('keeps the loaded contact source resolution when the saved value is unavailable', () => {
    useDafcStore.setState({
      dafcLoaded: true,
      dafcResolution: 1000,
      dafcResolutions: [1000, 5000],
      matrixNormalization: 'none',
    });

    applyImportedState({
      datasets: [], overlays: [], has_fasta: false,
      frontend: { dafcSettings: { dafcResolution: 25000, matrixNormalization: 'oe' } },
    });

    expect(useDafcStore.getState().dafcResolution).toBe(1000);
    expect(useDafcStore.getState().matrixNormalization).toBe('oe');
  });
});

describe('session transport', () => {
  it('exports sessions with the browser session cookie', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      blob: async () => new Blob(['{}'], { type: 'application/json' }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await exportSession();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/session/export');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
  });

  it('imports sessions with the browser session cookie', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({
        success: true,
        datasets: [],
        overlays: [],
        has_fasta: false,
        frontend: {},
        viewport: { chrom: 'chr2R', start: 100, end: 200 },
      }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    useDafcStore.setState({
      linkedSessions: [{ id: 'stale' } as any],
      currentLinkedSessionId: 'stale',
      linkedReadCount: 10,
      linkedVersion: 3,
    });

    await importSession({ version: '2.0' });

    // The import, then the imported tracks (for their name filters).
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/session/import');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(String(init?.body))).toEqual({ session: { version: '2.0' } });
    expect(useDafcStore.getState()).toMatchObject({
      linkedSessions: [], currentLinkedSessionId: null,
      linkedReadCount: 0, linkedVersion: 0,
    });
  });
});

describe('the imported session starts its history at once (Codex review)', () => {
  it.each([false, true])('keeps the legacy history pointer through import and dual-write export (redo branch: %s)', async withRedo => {
    const session = JSON.parse(readFileSync(resolve(process.cwd(), '../../tests/fixtures/sessions/301-peaks-history.json'), 'utf8'));
    if (withRedo) session.frontend.historySnapshots.push({
      ...structuredClone(session.frontend.historySnapshots[0]), label: 'Later edit',
    });
    const fetchMock = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => String(url).includes('/session/import') ? { ...session, success: true } : { tracks: [] },
      blob: async () => new Blob(),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    await importSession(session);
    // The navigation effect's restore echo must preserve the imported pointer and redo branch.
    useBrowserStore.getState().pushSnapshot('Navigate to restored viewport', { kind: 'navigation' });
    const state = useBrowserStore.getState();
    expect(state._historyPointer).toBe(session.frontend.historyPointer);
    expect(state._historyStack.map(h => h.label)).toEqual(session.frontend.historySnapshots.map((h: any) => h.label));
    expect(state.canRedo()).toBe(withRedo);
    await exportSession();
    const body = JSON.parse(String(fetchMock.mock.calls.find(([url]) => String(url).includes('/session/export'))?.[1]?.body));
    expect(body.frontend_state.historyPointer).toBe(session.frontend.historyPointer);
    expect(body.frontend_state.historySnapshots).toHaveLength(session.frontend.historySnapshots.length);
    for (const [i, snapshot] of session.frontend.historySnapshots.entries()) {
      expect(body.frontend_state.historySnapshots[i].state.selectedPeaks).toEqual(snapshot.state.selectedPeaks);
    }
  });

  it("records 'Import session' before the track list is read, so the view-moved effect never records the previous session", async () => {
    let releaseTracks: (v: Response) => void = () => undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('/session/import')) {
        return { ok: true, json: async () => ({ success: true, datasets: [], overlays: [], has_fasta: false, viewport: { chrom: 'chr3L', start: 1, end: 500 } }) } as Response;
      }
      return new Promise<Response>(resolve => { releaseTracks = resolve; });
    }));
    const old = collectFrontendState();
    useBrowserStore.setState({ _historyStack: [{ label: 'Old edit', timestamp: 1, state: old }], _historyPointer: 0 } as any);
    const done = importSession({ version: '2.0' });
    try {
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(useBrowserStore.getState()._historyStack.map(h => h.label)).toEqual(['Import session']);
      // The view-moved effect's echo (a navigation push right after) is not a step.
      useBrowserStore.getState().pushSnapshot('Navigate to chr3L:1-500', { kind: 'navigation' });
      expect(useBrowserStore.getState()._historyStack).toHaveLength(1);
    } finally {
      releaseTracks({ ok: true, json: async () => ({ tracks: [] }) } as Response);
      await done;
    }
  });
});

describe('track name filters on import', () => {
  it("drops the previous session's filters and mirrors the imported tracks' own", async () => {
    useBrowserStore.setState({ trackFilters: { 0: ['CTCF'] } } as any);
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => ({
      ok: true,
      json: async () => (String(url).startsWith('/api/tracks')
        ? { tracks: [
          { index: 0, label: 'JASPAR', path: '/x/jaspar.bb', render_mode: 'annotation', filter_names: ['REST'] },
          { index: 1, label: 'Signal', path: '/x/s.bw', render_mode: 'signal', filter_names: [] },
        ] }
        : { success: true, datasets: [], overlays: [], has_fasta: false, frontend: {},
          viewport: { chrom: 'chr2R', start: 100, end: 200 } }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await importSession({ version: '2.0' });

    expect(useBrowserStore.getState().trackFilters).toEqual({ 0: ['REST'] });
  });

  it('clears them even when the track list cannot be read', () => {
    useBrowserStore.setState({ trackFilters: { 0: ['CTCF'] } } as any);
    applyImportedState({ datasets: [] });
    expect(useBrowserStore.getState().trackFilters).toEqual({});
  });
});

describe('restore layout refresh',()=>{
  it.each(['sample','all'] as const)('refreshes imported %s geometry',mode=>{
    const before=useBrowserStore.getState().refreshGeneration;
    applyImportedState({frontend:{readDisplayMode:mode,readScrollOffsets:{ds1:72},uiScale:2}});
    const state=useBrowserStore.getState();
    expect(state.refreshGeneration).toBe(before+1);
    expect(state.uiScale).toBe(2);
    expect(state.readScrollOffsets).toEqual(mode==='all'?{ds1:72}:{});
  });
});
