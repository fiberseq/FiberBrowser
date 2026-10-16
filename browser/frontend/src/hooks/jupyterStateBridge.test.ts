import { beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../stores/browserStore';
import { useCoaccStore } from '../stores/coaccStore';
import { DEFAULT_COLORMAP } from '../types';
import { ensureBuiltinPanelsRegistered } from '../stores/__tests__/helpers';
import {
  applyJupyterStateToBrowser,
  buildJupyterBrowserSettingsPayload,
  serializeSelectedReadIds,
} from './jupyterStateBridge';

beforeEach(() => {
  localStorage.clear();
  ensureBuiltinPanelsRegistered();
  useBrowserStore.setState({
    chrom: 'chr2L',
    start: 100,
    end: 300,
    datasets: [{ id: 'ds1', label: 'Dataset 1', data_type: 'bam', available_layers: { nuc: true, tf: true, fire: true } }] as any,
    selectedReadIds: {},
    jupyterHighlights: [],
    jupyterMarkers: [],
    jupyterFootprintColors: [],
    jupyterReadOrder: {},
    jupyterReadFilter: {},
    jupyterPushedReads: null,
    jupyterVersion: 0,
    analysisSampleSeed: 'default-seed',
    analysisSampleCount: null,
    downsampleCount: null,
    readDisplayMode: 'sample',
    allReadsDisplayCap: 10000,
    backgroundReadCap: null,
    spanningOnly: false,
    peaksLocked: false,
    selectedPeaks: new Set(),
    peakRules: [],
    peaksByRule: {},
    activeColormap: { ...DEFAULT_COLORMAP },
    enabledModTypes: {},
    enabledMetaProfiles: {},
    cachedLayerTypes: {},
    clickTargetLayer: null,
    footprintAnalysisLayer: null,
    hiddenStripPanels: new Set(),
    panels: [],
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
});

describe('Jupyter browser bridge', () => {
  it('serializes browser selection and quality state for Python/Jupyter reads-back workflows', () => {
    expect(serializeSelectedReadIds({ ds1: new Set(['read_a', 'read_b']), ds2: new Set() }))
      .toEqual({ ds1: ['read_a', 'read_b'] });

    const payload = buildJupyterBrowserSettingsPayload({
      analysis_sample_seed: 'paper-v1',
      read_display_mode: 'all',
      all_reads_display_cap: 15000,
      background_read_cap: 50000,
      active_colormap: {
        ...DEFAULT_COLORMAP,
        qualityFilters: [{ layer: 'msp', qualityName: 'aq', minValue: 230, enabled: true }],
      },
      selected_peaks_set: new Set([1, 2]),
      peak_modes: { 1: 'accessibility' },
      cluster_feature_rules: [{ id: 'cluster-a', name: 'TF clusters', enabled: true, terms: [] }],
      analysis_sort_rules: [{ id: 'sort-a', name: 'TF sort', enabled: true, terms: [], metric: 'count', descending: true }],
      analysis_filter_rules: [{ id: 'filter-a', name: 'TF filter', enabled: true, terms: [], metric: 'count', operator: 'gte', threshold: 1 }],
      selected_read_ids: { ds1: new Set(['read_a']) },
      selected_genes: [{ id: 'tx1', name: 'GeneA', chrom: 'chr2L', start: 100, end: 300, strand: '+', biotype: 'protein_coding', exons: [] }],
      transcription_state_filters: { pause: true, pic: false, elongating: null },
      primer_saved_primers: [{ name: 'PrimerA', pair: { fwd_seq: 'ATGC', rev_seq: 'GCAT' }, chrom: 'chr2L' }],
      primer_mode: 'standard',
      primer_cart_track_display: 'design',
      panels: [{ id: 'panel-read-stats', contentType: 'read-stats' }],
      hidden_strip_panels_set: new Set(['history']),
    } as any, {
      coaccTrackMode: 'heatmap',
      coaccSignalType: 'small_fp',
      coaccLayer: 'tf',
      coaccNormalization: 'correlation',
      coaccScaling: 'linear',
      coaccColormap: 'fall',
      coaccMinCoverage: 20,
      coaccBinSize: 100,
      coaccArcThreshold: 1.5,
      coaccArcMaxArcs: 200,
      coaccArcMinDistance: 2,
      coaccV4cViewpoint: null,
    });

    expect(payload.selected_peaks).toEqual([1, 2]);
    expect(payload.peak_modes).toEqual({ 1: 'accessibility' });
    expect(payload.cluster_feature_rules?.[0].id).toBe('cluster-a');
    expect(payload.analysis_sort_rules?.[0].id).toBe('sort-a');
    expect(payload.analysis_filter_rules?.[0].id).toBe('filter-a');
    expect(payload.selected_read_ids).toEqual({ ds1: ['read_a'] });
    expect(payload.selected_genes?.[0].id).toBe('tx1');
    expect(payload.transcription_state_filters?.pause).toBe(true);
    expect(payload.primer_saved_primers?.[0].name).toBe('PrimerA');
    expect(payload.primer_mode).toBe('standard');
    expect(payload.primer_cart_track_display).toBe('design');
    expect(payload.read_display_mode).toBe('all');
    expect(payload.all_reads_display_cap).toBe(15000);
    expect(payload.background_read_cap).toBe(50000);
    expect(payload.active_quality_filters).toEqual([{ layer: 'fire', quality_name: 'aq', min_value: 230 }]);
    expect(payload.active_panels).toEqual([{ id: 'panel-read-stats', content_type: 'read-stats' }]);
    expect(payload.hidden_strip_panels).toEqual(['history']);
    expect(payload.session_manifest?.sessionName).toBe('Untitled session');
  });

  it('applies notebook commands to the live browser store, including visual read selection', () => {
    applyJupyterStateToBrowser({
      version: 7,
      has_custom_reads: true,
      has_pushed_reads: true,
      pushed_reads: [{ id: 'read_a', intervals: [[0, 100, 100]] }],
      has_order: true,
      has_filter: true,
      has_highlights: true,
      has_markers: true,
      has_footprint_colors: true,
      highlights: [{ id: 'h1', type: 'read', read_ids: ['read_a'], color: '#ff0000', dataset_id: 'ds1' } as any],
      markers: [{ id: 'm1', group: 'default', markers: [{ position: 150, color: '#00ff00' }] } as any],
      footprint_colors: [{ id: 'fc1', group: 'default', footprint_colors: { read_a: [{ start: 10, end: 20, color: '#0000ff' }] } } as any],
      read_order: { ds1: ['read_b', 'read_a'] },
      read_filter: { ds1: ['read_a'] },
      selected_read_ids: { ds1: ['read_a'] },
      goto: { chrom: 'chr3R', start: 1000, end: 2000 },
      settings_update: {
        analysis_sample_seed: 'notebook-seed',
        analysis_sample_count: 5000,
        display_sample_count: 600,
        read_display_mode: 'all',
        all_reads_display_cap: 15000,
        background_read_cap: 25000,
        spanning_only: true,
        peak_modes: { 4: 'tf' },
        cluster_feature_rules: [{ id: 'cluster-b', name: 'Nuc clusters', enabled: true, terms: [] }],
        analysis_sort_rules: [{ id: 'sort-b', name: 'Nuc sort', enabled: true, terms: [], metric: 'occupancy', descending: true }],
        analysis_filter_rules: [{ id: 'filter-b', name: 'Nuc filter', enabled: true, terms: [], metric: 'count', operator: 'gte', threshold: 2 }],
        selected_genes: [{ id: 'tx2', name: 'GeneB', chrom: 'chr3R', start: 1000, end: 1500, strand: '-', biotype: 'protein_coding', exons: [] }],
        transcription_state_filters: { pause: false, pic: true, elongating: 2 },
        primer_saved_primers: [{ name: 'PrimerB', pair: { fwd_seq: 'AAAA', rev_seq: 'TTTT' }, chrom: 'chr3R' }],
        primer_mode: '4c',
        primer_cart_track_display: 'all',
        enabled_mod_types: { msp: true },
        cached_layer_types: { msp: false },
        click_target_layer: 'msp',
        footprint_analysis_layer: 'tf_layer',
        fill_read_height: true,
        read_row_height: 12,
        show_coverage_histogram: true,
        open_panel: 'read-stats',
        // Queued by two notebook calls between polls: both panels open.
        panel_ops: [['open', 'co-accessibility'], ['open', 'contact-map']],
        coacc_settings: {
          coaccTrackMode: 'arc',
          coaccSignalType: 'small_fp',
          coaccLayer: 'msp',
          coaccNormalization: 'oe_distance',
          coaccScaling: 'sqrt',
          coaccColormap: 'viridis',
          coaccMinCoverage: 35,
          coaccBinSize: 250,
          coaccArcThreshold: 2.5,
          coaccArcMaxArcs: 75,
          coaccArcMinDistance: 4,
          coaccV4cViewpoint: { start: 120, end: 140, label: 'vp' },
        },
      },
    });

    const state = useBrowserStore.getState();
    expect(state.jupyterVersion).toBe(7);
    expect(state.chrom).toBe('chr3R');
    expect(state.start).toBe(1000);
    expect(state.end).toBe(2000);
    expect(state.jupyterPushedReads?.[0].id).toBe('read_a');
    expect(state.jupyterReadOrder.ds1).toEqual(['read_b', 'read_a']);
    expect(state.jupyterReadFilter.ds1).toEqual(['read_a']);
    expect(state.selectedReadIds.ds1.has('read_a')).toBe(true);
    expect(state.analysisSampleSeed).toBe('notebook-seed');
    expect(state.analysisSampleCount).toBe(5000);
    expect(state.downsampleCount).toBe(600);
    expect(state.readDisplayMode).toBe('all');
    expect(state.allReadsDisplayCap).toBe(15000);
    expect(state.backgroundReadCap).toBe(25000);
    expect(state.spanningOnly).toBe(true);
    expect(state.peakModes).toEqual({ 4: 'tf' });
    expect(state.clusterFeatureRules[0].id).toBe('cluster-b');
    expect(state.analysisSortRules[0].id).toBe('sort-b');
    expect(state.analysisFilterRules[0].id).toBe('filter-b');
    expect(state.selectedGenes[0].id).toBe('tx2');
    expect(state.transcriptionStateFilters.pic).toBe(true);
    expect(state.transcriptionStateFilters.elongating).toBe(2);
    expect(state.primer.savedPrimers[0].name).toBe('PrimerB');
    expect(state.primer.mode).toBe('4c');
    expect(state.primer.cartTrackDisplay).toBe('all');
    expect(state.enabledModTypes.fire).toBe(true);
    expect(state.cachedLayerTypes.fire).toBe(false);
    expect(state.clickTargetLayer).toBe('fire');
    expect(state.footprintAnalysisLayer).toBe('tf');
    expect(state.fillReadHeight).toBe(true);
    expect(state.readRowHeight).toBe(12);
    expect(state.showCoverageHistogram).toBe(true);
    expect(state.panels.some(panel => panel.contentType === 'read-stats')).toBe(true);
    expect(state.panels.some(panel => panel.contentType === 'co-accessibility')).toBe(true);
    expect(state.panels.some(panel => panel.contentType === 'contact-map')).toBe(true);
    expect(useCoaccStore.getState()).toMatchObject({
      coaccTrackMode: 'arc',
      coaccLayer: 'fire',
      coaccNormalization: 'oe_distance',
      coaccScaling: 'sqrt',
      coaccBinSize: 250,
    });
  });
});

describe('Jupyter refresh', () => {
  it('a refresh request refetches the current view', () => {
    const before = useBrowserStore.getState().refreshGeneration;
    applyJupyterStateToBrowser({ refresh: true } as never);
    expect(useBrowserStore.getState().refreshGeneration).toBe(before + 1);
  });
});
